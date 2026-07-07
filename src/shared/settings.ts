import type { OverlaySettings } from "./types";

export const defaultSettings: OverlaySettings = {
  maxMessages: 80,
  fontSize: 22,
  showBadges: true,
  showSourceLabel: true,
  showTimestamps: false,
  compactMode: false,
  messageLifetimeSec: 0,
  backgroundOpacity: 0.44
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export function normalizeSettings(input: Partial<OverlaySettings>): OverlaySettings {
  return {
    maxMessages: clamp(Math.round(input.maxMessages ?? defaultSettings.maxMessages), 10, 300),
    fontSize: clamp(Math.round(input.fontSize ?? defaultSettings.fontSize), 14, 42),
    showBadges: input.showBadges ?? defaultSettings.showBadges,
    showSourceLabel: input.showSourceLabel ?? defaultSettings.showSourceLabel,
    showTimestamps: input.showTimestamps ?? defaultSettings.showTimestamps,
    compactMode: input.compactMode ?? defaultSettings.compactMode,
    messageLifetimeSec: clamp(
      Math.round(input.messageLifetimeSec ?? defaultSettings.messageLifetimeSec),
      0,
      120
    ),
    backgroundOpacity: clamp(input.backgroundOpacity ?? defaultSettings.backgroundOpacity, 0, 0.9)
  };
}
