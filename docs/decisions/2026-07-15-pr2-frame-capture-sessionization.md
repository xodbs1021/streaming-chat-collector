# PR2 — 프레임 캡처 세션화: 설계 결정 기록

> **상태:** 설계 확정, 구현 착수 전
> **날짜:** 2026-07-15
> **관련:** data-layout-restructure 리팩터 4PR 계획 중 PR2 · PR1 = #30 (master `ac5f97d`)
> **성격:** 착수 전 설계 승인 게이트에서 사용자와 나눈 논의 전체를 보존한 문서.
> 유지보수 시 "왜 이렇게 짰나"의 1차 근거이자, 추후 블로그 글의 원자료.

---

## 0. 이 문서를 남기는 이유

큰 아키텍처 변경(데이터 저장 구조를 방송 단위 세션 디렉토리로 재편)의 두 번째 조각이다.
코드 diff만 봐서는 **왜 싱글턴을 택했는지, 왜 grace 동안 캡처를 안 끄는지, 왜 읽기 API를 안 건드렸는지**가 드러나지 않는다.
특히 이번 논의는 **추천이 A→B→A로 한 번 뒤집힌** 과정을 포함한다. 그 뒤집힘의 이유(= "병렬"의 정의가 서로 달랐다)가
이 시스템 구조를 이해하는 핵심이라, 결론만이 아니라 **판단 경로 전체**를 남긴다.

---

## 1. 배경

### 1.1 리팩터 큰 그림 (4PR)

`data/` 저장 구조를 provider별 전역 디렉토리에서 **방송(broadcast) 단위 세션 디렉토리**로 옮긴다.

목표 레이아웃:

```
data/<broadcastId>/
├── broadcast.meta.json
├── chat/<provider>/   { chat.jsonl · meta.json · viewers.jsonl · markers.json · highlights.json }
└── frame/<provider>/  <epoch초>.jpg
```

| PR | 내용 | 위험도 | 상태 |
|----|------|--------|------|
| PR1 | 방송 라이프사이클 + recorder 재작성, 연결/녹화 분리, `chat/` 쓰기, 자동종료 grace | 고 | ✅ #30 머지 |
| **PR2** | **프레임 캡처 세션화 — 전역→방송 범위, 녹화 중에만, `frame/<provider>/`** | **고** | **이 문서** |
| PR3 | 읽기 경로 + 프레임 인덱스 API 새 레이아웃 대응 | 중 | 예정 |
| PR4 | 대시보드: 세션=방송(provider 2개) + 녹화 시작/종료 UI | 중 | 예정 |

원칙(하네스): **한 PR = 한 논리적 변경 = revert 하나로 롤백.** master 직접 커밋 금지, 스택 PR 금지, squash merge, 머지는 사용자 승인 후.

### 1.2 제0원칙

> 모든 개발은 SOLID를 따른다. 기계가 아닌 **사람이 이해할 수 있는 모듈/메서드 단위**로 만든다.
> 메서드명만 보고 기능이 파악되어야 하고(이름=계약), 구현은 갈아끼울 수 있어야 한다.

이 원칙이 아래 여러 결정의 최종 심판 기준이었다.

### 1.3 PR1이 이미 만들어 둔 것 (그대로 활용)

- recorder 방송 라이프사이클: `startRecording(providers)` / `stopRecording()` / `isRecording()` / `getActiveBroadcastId()`, 단일 `activeBroadcast`.
- 소켓 이벤트 `recording:start` / `recording:stop`.
- 자동종료 grace: 방송 종료(모든 provider offline) 감지 후 `RECORD_GRACE_MS`(3분) 뒤 자동 확정. `broadcastId` = `<YYYYMMDD-HHMMSS>-<6hex>`.
- `src/server/broadcast/broadcastPaths.ts` — 경로 단일 진실원. **여기에 `frameDir(broadcastId, provider)`를 추가**한다.
- 저장 루트 = `chatDataDir`(`./data/chat-sessions`). 실제 경로 = `./data/chat-sessions/<broadcastId>/frame/<provider>/`.

### 1.4 PR2 착수 시점의 현행 프레임 구조 (바꿀 대상)

- `src/server/index.ts` 부팅 시 `FrameCaptureManager` 2개를 **전역 고정 경로**로 생성 (`…/frames/chzzk`, `…/frames/soop`).
- 캡처가 **연결(connect)에 묶임**: `connectProvider` → `primeCaptureAndWait` → `manager.start(channelId)` + `waitUntilReady`("이미지 준비 중…" 게이트). `disconnectProvider` → `manager.stop()`.
- 읽기 API(`routes/frames.ts`)는 **라이브 매니저 인스턴스 경유** — `framePath`(=`framesDir` 기준)·`listFrameSeconds`·`nearestFrame`를 provider 키로만 노출. 클라(`frameIndexClient`)도 `/api/frames/:provider/*`로 broadcastId 없이 조회.

---

## 2. 결정 요약

| # | 질문 | 결정 | 한 줄 근거 |
|---|------|------|-----------|
| Q1 | 연결만 한 상태에서 라이브 프리뷰 캡처 유지? readiness 게이트("이미지 준비 중…")는? | **녹화에만 묶되, 게이트는 '녹화 시작'으로 이동** | 메모리 확정 #5(녹화 중에만 캡처) 준수 + 기존 readiness UX는 버리지 않고 녹화 버튼으로 이전 |
| Q2 | grace 3분 동안 캡처를 계속? 방송종료 감지 즉시 중단? | **finalize(녹화 확정)에서 중단** | start↔stop을 둘 다 **녹화 경계**에 대칭으로. 재접속 자동재개는 기존 백오프가 공짜로 처리 |
| Q3 | 매니저를 방송마다 재생성? framesDir를 start()에 주입? | **provider당 싱글턴 + `start(channelId, framesDir)` 주입** | **한 프로세스 = 한 방송**(다중 인스턴스 모델)이라 in-process 다방송 컨트롤러는 YAGNI |
| Q4 | write가 방송범위로 바뀌면 read API는? | **읽기 라우트 무변경 (provider 키, 라이브 매니저 경유)** | 읽기·쓰기가 같은 매니저·같은 폴더를 통과 → 계약 shape 불변, PR2 green. 과거 방송 열람은 PR3 |

---

## 3. 개념 정리 (논의 중 명확히 한 것들)

### 3.1 provider = 방송 플랫폼

`type ChatProvider = "chzzk" | "soop"`.
- **chzzk** = 네이버 CHZZK, **soop** = 옛 아프리카TV(SOOP).
- 각 provider는 한 채널에 붙어 **채팅 + 시청자 수 + 영상 프레임(HLS 스트림)**을 준다.
- **한 방송(broadcast)** = 한 스트리머의 방송. chzzk·soop **동시송출**이면 **한 방송 세션에 provider 2개**가 붙는다 → `frame/chzzk/`, `frame/soop/`로 갈라짐.
- 현행 시스템은 provider당 채널 1개(총 최대 2 스트림) = **한 방송**만 다룬다.

### 3.2 연결 ⊥ 녹화 (PR1에서 확정)

- **연결(provider:connect)** = 실시간 채팅·시청자 수 **대시보드 표시**만. 디스크 저장·프레임 캡처 안 함.
- **녹화 시작** = 방송 세션 디렉토리를 열고 그때부터 저장. **녹화 종료** = 저장 중단(연결은 유지 가능).
- PR2는 **이 분리를 프레임에도 적용**한다(현행은 "연결=즉시 캡처").

### 3.3 grace의 실제 동작 (오해가 있었던 부분)

방송 종료(provider offline) 감지 시 현행 코드(`onStatus`)는:

1. `disconnectProvider()` — **연결을 즉시 끊는다**(어댑터 제거).
2. `scheduleAutoStopIfBroadcastEnded()` — 살아있는 provider가 없으면 grace 3분 타이머 + `autoStopPending=true`.
3. 3분 뒤 `finalizeRecording()` → `recorder.stopRecording()`.

**핵심:** grace 동안은 **연결이 이미 끊겨 있어 채팅도 프레임도 0**이다. grace의 실효는 딱 하나 —
**grace(3분) 안에 사용자가 수동으로 재연결하면, 새 `broadcastId`를 만들지 않고 직전 방송 세션에 이어서 저장**한다.
즉 "짧은 끊김·재접속에 한 방송이 두 세션으로 쪼개지는 것"을 막는 용도. (재접속은 현재 **수동**이다 — 자동 재연결은 PR2 밖의 미래 기능.)

| 대상 | 방송종료 감지 시 | grace 3분 | finalize |
|------|-----------------|-----------|----------|
| 연결(어댑터) | 즉시 끊김 | 끊긴 상태 | — |
| 녹화 세션(`data/<broadcastId>/`) | **열린 채 유지** | 열린 채 유지 | 닫힘 |

> 저장(채팅·프레임)은 "연결"이 아니라 "**녹화 세션**"의 수명에 묶인다. 이게 Q2 결정의 토대다.

---

## 4. 결정별 상세

### Q1 — 캡처를 connect에서 record로 옮길 때 readiness 게이트 처리

**문제.** 현행 connect 흐름은 `primeCaptureAndWait`로 캡처를 먼저 기동하고 `waitUntilReady`(최대 15초)로
"이미지 준비 중…"을 노출하며 채팅 시작을 게이팅한다(`planFromReadiness`). 캡처가 record로 옮겨가면 이 게이트는 갈 곳이 없다.

**선택지.**
- (A) 녹화에만 묶고 게이트 제거 — 연결 시 캡처 안 함, 채팅 즉시 연결. 녹화 시작 시 캡처 백그라운드 기동(대기 없음).
- (B) 녹화에만 묶되 **게이트를 '녹화 시작'으로 이동** — '녹화 시작' 누르면 캡처 선기동 + 최대 15초 대기 후 채팅/캡처/저장 동시 시작.
- (C) 연결 시 라이브 프리뷰 캡처 유지(현행) + 녹화 시 별도 저장 → 확정 #5 위배, ffmpeg 2중 실행.

**결정: B.** 확정 #5("녹화 중에만 캡처")를 지키면서도, 이미 만들어 둔 readiness UX(캡처가 실제 프레임을 뱉기 시작할 때까지
기다렸다 함께 시작)를 버리지 않고 **녹화 버튼으로 이전**한다. `primeCaptureAndWait`/`waitUntilReady`/`planFromReadiness`는
connect가 아니라 record-start 경로에서 재사용된다.

### Q2 — grace 동안 캡처 수명

**논의.** 사용자 지적: "offline 감지 순간 연결을 끊으면 ffmpeg도 멈춰서 어차피 grace 동안 프레임 못 딴다. 그럼 grace가 무슨 소용?"
→ 맞다(§3.3). grace 동안은 어느 선택이든 **저장 프레임 0장**. 그래서 이 결정은 **저장 결과가 아니라 코드 정돈**의 문제다.

**선택지.**
- (A) **finalize에서 중단** — grace 동안 매니저는 살아있되 소스 offline이라 no-hls 백오프(프레임 0). grace 안에 재접속하면 **기존 백오프가 스트림을 다시 잡아 자동 재개**. `startRecording`↔`finalizeRecording`에 start↔stop 대칭.
- (B) 방송종료 감지(연결 해제) 즉시 중단 — 직관적이나 **시작은 녹화 수명, 중단은 연결 수명** = 비대칭(냄새). grace 중 재접속 시 캡처를 되살릴 **명시적 재기동 배선을 새로 추가**해야 함. provider 2개면 offline 분기 개별 처리.

**결정: A.** start와 stop을 둘 다 녹화 경계에 두는 **대칭성**이 핵심 근거. PR2에서 캡처 시작은 `startRecording`에 묶이고,
재접속은 `startRecording`을 다시 부르지 않으므로(이미 녹화 중), 매니저를 살려두는 A라야 재개가 기존 백오프로 공짜로 된다.

### Q3 — 매니저 형태 (추천이 뒤집힌 결정)

이 결정은 **"병렬"의 정의**에 달려 있었고, 그걸 확인하는 과정에서 추천이 A→B→A로 움직였다. 그대로 기록한다.

**1차 추천: A (싱글턴 + start(dir) 주입).**
근거 — provider당 매니저 2개 identity를 부팅 내내 고정하면 읽기 라우트가 무변경(§Q4). 최소 diff.

**사용자 개입: "나중에 이 시스템을 병렬로 돌려 여러 방송을 동시 수집할 거다. 확장성 고려하면?"**

**2차 추천: B (방송별 매니저 + BroadcastCaptureController).**
근거 — **"한 프로세스가 방송 여러 개를 동시 저글링"**한다고 가정. 그러면 싱글턴 `{chzzk,soop}`는 "동시 방송 1개"를
구조에 각인시켜 병렬을 막는다. 방송별로 `FrameCaptureManager`를 소유하는 작은 컨트롤러가:
- FrameCaptureManager를 무수정(생성자 framesDir 유지)으로 두고 → 기존 테스트 green,
- 방송별 상태(assigner·인덱스·타이머) 완전 격리,
- 읽기 라우트가 컨트롤러만 보게 해두면 병렬 확장의 seam 확보.

**사용자 재개입 (결정타): "내 병렬 모델은 admin에서 '생성' 클릭 → 지금 이 싱글턴 시스템 한 벌이 통째로 뜨는 것.
방송 N개면 인스턴스 N개."**

→ 즉 병렬 = **다중 프로세스(인스턴스), 각 프로세스는 방송 1개.** in-process 다방송이 **절대 일어나지 않는다.**

**최종 결정: A (싱글턴 + `start(channelId, framesDir)` 주입).**
- 한 프로세스 안엔 언제나 방송 최대 1개 → provider당 캡처 엔진 1개(싱글턴)로 충분·정답.
- 컨트롤러(한 프로세스 다방송 소유)는 네 모델에선 **절대 안 쓰이는 기능 = YAGNI 과설계**.
- `framesDir` 주입은 여전히 필요 — 한 인스턴스가 수명 동안 방송을 여러 번(순차) 녹화할 수 있고, 매 녹화가 자기
  `data/<broadcastId>/frame/<provider>/`를 가리켜야 하므로. 방송별 인덱스/assigner는 `start()`에서 리셋.

> **교훈:** "확장성을 고려하라"는 요구는 **어떤 확장이냐를 먼저 확정**해야 방향이 정해진다.
> in-process 다방송과 다중 인스턴스는 정반대의 코드를 부른다. 잘못된 확장을 위한 설계는 그냥 과설계다.

### Q4 — 읽기 seam

**문제.** 쓰기가 방송 폴더로 옮겨가면, 아직 전역 provider 기준인 읽기 API(`routes/frames.ts`)와 어긋날 구간이 생긴다.

**메커니즘.** 읽기 라우트는 디스크를 경로로 직접 읽지 않고 **라이브 매니저 객체에 물어본다**
(`manager.listFrameSeconds`, `manager.framePath(n)` = `manager.framesDir/n.jpg`). 즉 답은 늘 "매니저가 지금 가리키는 폴더".

**선택지.**
- (A) **읽기 라우트 무변경.** Q3=A로 매니저가 녹화 중엔 `data/<broadcastId>/frame/<provider>/`를 가리키므로,
  읽기가 자동으로 현재 방송 프레임을 반환. URL `/api/frames/:provider/*` shape 불변 → PR2 green. 과거 방송 열람은 PR3(broadcastId 읽기 URL).
- (B) PR2에서 `/api/frames/:broadcastId/:provider/*` 선반영 → PR3 범위 당겨옴, diff↑, 한 PR=한 변경 위반.

**결정: A.** Q3=A면 사실상 자동으로 따라온다 — 안정된 매니저가 활성 방송 폴더를 가리키니 기존 라우트가 무변경으로 green.
- 녹화 중: reads가 현재 방송 프레임 반환(읽기·쓰기가 같은 매니저·폴더 통과).
- 비녹화/과거 방송: 매니저가 폴더를 안 가리켜 빈 인덱스/404. **과거 방송을 provider만으로 부르는 기능은 PR3/PR4.**

> soop 캡처 개발과 무관하다. soop 매니저·라우트·HLS 조회(`fetchSoopHlsUrl`)는 이미 chzzk와 대칭으로 배선돼 있고
> (실전 검증은 별개 과제), PR2는 양쪽을 동일하게 다룰 뿐. soop를 먼저 개발할 필요 없다.

---

## 5. 병렬 확장 모델과 PR1/PR2의 관계

### 5.1 채택된 모델: 다중 인스턴스 (프로세스-당-방송)

admin '생성' 클릭 → 싱글턴 시스템(admin+dashboard+recorder+capture) 한 벌이 통째로 기동, 방송 1개 담당.
방송 N개 = 인스턴스 N개.

**장점:** 강한 격리(한 방송 크래시가 다른 방송 안 죽임), 인스턴스 코드 단순(프로세스 내부 멀티테넌트 복잡도 0),
수평 확장 쉬움. **단점:** 프로세스 N개라 메모리 오버헤드↑, 포트·프로세스 관리, 교차-방송 집계는 별도 계층 필요.
→ 방송 몇 개 규모에선 격리 이득 > 오버헤드. **비효율 아님.** 수십 개+ 동시면 그때 in-process 다방송(컨트롤러)로 재검토.

### 5.2 PR1은 이 모델을 안 막는다 (오히려 이상적)

- **데이터 루트 충돌 없음:** 인스턴스들이 `./data/chat-sessions/`를 공유해도 각 방송은 고유 `broadcastId`
  (`YYYYMMDD-HHMMSS-<6hex>`, 6hex 랜덤이라 같은 초에 떠도 충돌 불가) 하위 폴더로 갈라짐. **방송별 레이아웃이 딱 맞다.**
- **포트:** `process.env.PORT ?? 4010` — env 주도. 오케스트레이터가 인스턴스마다 다른 PORT만 주면 됨.
- **모듈 싱글턴(recorder/capture/io):** 프로세스마다 각자 소유 → 다중 프로세스에서 자연 격리.
- **recorder.activeBroadcast 1개:** 인스턴스=방송 1개 모델과 정확히 일치.

### 5.3 병렬에 남는 일 (전부 PR2 밖, 상위 오케스트레이션 계층)

1. '생성' 시 프로세스 spawn + 포트 배정
2. 떠 있는 인스턴스 레지스트리/프록시
3. 모든 방송을 한 화면에서 보는 **교차-인스턴스 집계 대시보드**(`data/*/` 가로질러 읽기)

셋 다 PR1/PR2와 독립. PR2가 하드코딩으로 막는 것 없음.

---

## 6. 효율성 논점

**"chzzk/soop 중 하나만 연결하면 provider도 1개만 생성되나? 2개면 비효율 아닌가?"**

- **매니저 객체 생성** = 필드 세팅. 프로세스·타이머·I/O 0. 사실상 공짜.
- **실제 비용**(ffmpeg 자식 프로세스, 5초 인덱스 폴링 타이머, 시간당 보존 스윕, 인메모리 인덱스)은 전부 **`start()` 안**.
- 흐름: chzzk만 연결 → 녹화 시작 → **chzzk 매니저만 `start()`** → ffmpeg 1개. soop 매니저는 **dormant**(stopped, child 없음, 타이머 없음) → 비용 ≈ 0.
- 그래서 **`startRecording(providers)` 때 그 방송에 실제로 붙은 provider만 캡처를 켠다**(둘 다 무조건 X).
- dormant 객체를 굳이 안 만들 이유도 없음 — 생성이 공짜라 lazy가 얻는 게 없고, 읽기 라우트가 두 provider 모두
  `managerFor(provider)`로 물을 때 객체가 있어야 "프레임 없음"을 특별처리 없이 답한다(읽기 seam 무변경).

**결론: 연결한 provider 수 = 실제 캡처(ffmpeg) 수.** 안 붙은 provider는 잠자는 객체 하나.

---

## 7. 최종 설계 (모듈/메서드 수준 스케치)

> 세부 단계·테스트 계획은 planner 산출물(`_workspace/`)과 PR 본문에서 확정. 여기서는 계약 수준만.

**`broadcast/broadcastPaths.ts`**
- `frameDir(broadcastId, provider): string` 추가 → `<root>/<broadcastId>/frame/<provider>`.

**`frameCapture.ts` (FrameCaptureManager)**
- `framesDir`를 생성자 고정 → **`start(channelId, framesDir?)`로 대상 폴더 주입** 가능하게. 미주입 시 생성자 기본값(테스트 호환).
- 방송 경계 리셋: `start()`에서 프레임 인덱스·assigner를 방송별로 초기화(옛 방송 상태 비유입).
- 순수 캡처 엔진 성격 유지(이름=계약: "이 채널을 이 폴더로 캡처 시작").

**`index.ts`**
- 부팅 시 2 매니저는 유지하되, connect 경로의 `primeCaptureAndWait`/캡처 start·stop 배선 제거(연결⊥캡처).
- `startRecording()`: `connectedProviderRefs()`의 provider마다 `manager.start(channelId, frameDir(broadcastId, provider))` +
  readiness 게이트(Q1=B) 적용. 녹화 중 뒤늦게 붙는 provider도 캡처 합류.
- `finalizeRecording()`: 활성 provider 매니저 전부 `stop()` (Q2=A).
- `disconnectProvider()`: **캡처 stop 제거**(더는 연결에 안 묶임).
- 화질 변경(`applySettingsPatch`)·시그널 핸들러의 매니저 순회는 유지.

**`routes/frames.ts` / `frameIndexClient.ts` / `FramePreview.tsx`**
- **무변경**(Q4=A). PR3의 seam.

---

## 8. 범위 밖 / 후속

- **PR3:** broadcastId 인지 읽기 경로 + 프레임 인덱스 API(과거 방송 열람).
- **PR4:** 대시보드 세션=방송(provider 2개) + 녹화 시작/종료 UI.
- **병렬(에픽):** 인스턴스 spawn·포트 배정·레지스트리·교차-인스턴스 집계 대시보드.
- **자동 재연결:** 방송 재개 시 grace 안에서 시스템이 스스로 재연결(현재는 수동). PR2와 독립.
- **soop 캡처 실전 검증:** `fetchSoopHlsUrl`/`findHlsUrlDeep`가 실제 SOOP 라이브 응답에서 동작하는지 확인.

---

## 9. 블로그 앵글 (메모)

- "연결과 녹화를 분리한다"가 UI 토글 하나가 아니라 **저장·캡처·자동종료·세션 경계 전체를 재정의**하는 결정이었다는 점.
- **grace의 역설:** 끊긴 동안 아무것도 저장 안 하는데도 3분을 열어두는 이유(세션 분열 방지) — 수명(연결 vs 녹화 세션)의 분리.
- **추천이 뒤집힌 순간:** "확장성 고려"가 방향을 정하지 못하고, "**어떤** 확장이냐"(in-process 다방송 vs 다중 인스턴스)가
  정반대의 코드를 부른 사례. YAGNI와 전방호환 사이의 실전 판단.
- **읽기 seam이 공짜였던 이유:** 읽기·쓰기가 같은 매니저·같은 폴더를 통과하도록 두면, 폴더를 옮겨도 읽기 계약은 안 바뀐다.
