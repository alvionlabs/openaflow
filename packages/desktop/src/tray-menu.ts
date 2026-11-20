// The tray's menu: Open, Settings, and Quit. Settings opens the window on the settings page (#settings).

export type TrayMenuItem = { label: string; click(): void }

export function trayMenu(o: { onOpen(): void; onSettings(): void; onQuit(): void }): TrayMenuItem[] {
  return [
    { label: 'Open', click: () => o.onOpen() },
    { label: 'Settings', click: () => o.onSettings() },
    { label: 'Quit', click: () => o.onQuit() },
  ]
}
