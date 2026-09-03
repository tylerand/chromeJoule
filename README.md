# Chrome Joule

Chrome Joule is an unofficial Chrome extension for controlling a nearby Joule sous vide cooker over Bluetooth Low Energy. It is not affiliated with ChefSteps or Breville.

## Features

- Direct Bluetooth connection to a nearby Joule
- Automatic reconnecting overlay that preserves the dashboard after a temporary BLE disconnect
- Manual cook controls for temperature and an optional `hr : min : sec` device timer
- Live water-temperature, cook-phase, and timer updates
- Device timers and the time-at-temperature clock that begin when the bath reaches its selected temperature
- Add five or thirty minutes to an active or pending timer without repeatedly restarting Joule
- Pause the displayed timer while Joule continues to hold the target, then resume it with the preserved remaining time
- Browser notification when a timer completes, including when the controller tab is closed
- Fahrenheit and Celsius display modes

## Requirements

- Google Chrome on Windows with Bluetooth enabled
- A Joule that is powered on and not connected to another app

## Build and install

```sh
npm install
npm run build
```

In Chrome, open `chrome://extensions`, enable **Developer mode**, select **Load unpacked**, and choose the repository's `dist` directory. Select the extension icon to open the controller in a new tab.

## Testing

```sh
npm test
```

Runs the Jest unit test suite in `test/`, covering the Joule wire-protocol
encoding/decoding in `JouleBleClient.ts` and the pure cook/timer/dashboard
calculations in `BleJouleView.tsx` (timer state derivation, cook phase,
time-at-temperature accounting, and the UI-freeze snapshot used across a
Joule restart). These do not require a Joule or Bluetooth adapter. Run this
suite after any change that touches timer, cook-phase, or restart/freeze
logic to confirm behavior is unchanged.

## Pairing a Joule

1. Select **Connect Joule** and choose the cooker in Chrome's Bluetooth picker.
2. On the first connection, press the button on top of the Joule within 60 seconds.
3. Chrome Joule stores the resulting device-specific pairing key in local storage, so subsequent connections do not require the button press.

Close the Breville+ app, nRF Connect, and other Bluetooth clients before connecting; Joule supports only one Bluetooth connection at a time.

If Chrome cannot read the Joule advertiser data, enter its **Manufacturer Data** from nRF Connect under **Advanced** before connecting.

Selecting **Disconnect** deliberately removes the saved pairing key after
confirmation. The next connection will require you to press the Joule's top
button to pair again. In Developer mode, Disconnect ends only the simulated
connection and retains any saved pairing key.

## How it works

The extension opens a browser-based controller and communicates with Joule's Bluetooth GATT service directly. `JouleBleClient` encodes the subset of the Joule protocol needed to pair, subscribe to live data, and control manual programs. `BleJouleView` renders the controller and derives the displayed cook phase, timer progress, and time-at-temperature from device telemetry.

## Developer mode

Developer mode is disabled in the production build. Set
`DEVELOPER_MODE_ENABLED` to `true` in `src/BleJouleView.tsx` for local UI
testing without a Joule. It simulates a connected cooker locally and moves the
water temperature toward the selected target while exercising the same start,
stop, timer, and temperature-update controls. Developer mode never opens a
Bluetooth connection or sends commands to a device.

## Timers, temperature changes, and notifications

A selected timer is held locally until the bath reaches the target temperature,
then sent to the Joule and started. The **Time at temperature** clock
accumulates only while the water is at or above the active target. Raising the
target during a timed cook preserves the remaining duration but pauses the
timer until the new target is reached. Lowering the target below the current
bath temperature immediately updates the device timer with the remaining
duration.

Once a timer is set, **+5 min** and **+30 min** immediately extend the
displayed timer. When more than 30 seconds remain, Chrome Joule waits 30
seconds after the last press before it sends the combined extension to Joule.
Near completion, it sends the update immediately. This avoids repeated program
restarts when adding time several times.

Chrome Joule schedules a Chrome alarm whenever a running timer changes. The
alarm shows a browser notification at completion even when the controller tab
is closed. Keep Chrome running for the most reliable timer notifications.

If Joule temporarily disconnects while applying an updated cook command, Chrome
Joule retains the dashboard and reconnects the already-paired device
automatically. A retry button appears if that reconnect attempt fails.

## Limitations

- Only manual cook programs are supported.
- Recipe walkthroughs and multi-device management are not supported.
- The extension has been tested with Chrome on Windows only.
