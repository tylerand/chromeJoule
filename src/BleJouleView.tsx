import * as React from "react"
import JouleBleClient, { JouleData } from "./JouleBleClient"

declare const chrome: any

// Keep the simulator out of production builds unless it is explicitly enabled
// for local development.
const DEVELOPER_MODE_ENABLED = false

interface BleJouleViewProps {
  darkMode: boolean
  onToggleDarkMode: () => void
}

class BleJouleView extends React.Component<BleJouleViewProps, any> {
  private client = new JouleBleClient()
  private clockInterval: number
  private temperatureRefreshInterval: number
  private timerExtensionTimeout = 0
  private disconnectRequested = false
  private reconnectInProgress = false
  private cookRestartInProgress = false
  private hoursInput: HTMLInputElement | null = null
  private minutesInput: HTMLInputElement | null = null
  private secondsInput: HTMLInputElement | null = null

  public state = {
    status: "Connect directly to a nearby Joule over Bluetooth.",
    connected: false,
    connecting: false,
    developerMode: false,
    setPoint: "",
    cookHours: "",
    cookMinutes: "",
    cookSeconds: "",
    isCelsius: false,
    data: null,
    error: "",
    manufacturerData: localStorage.getItem("chrome-joule-manufacturer-data") || "",
    showAdvancedSettings: false,
    showDisconnectConfirmation: false,
    reconnecting: false,
    reconnectError: "",
    starting: false,
    dataReceivedAt: 0,
    timerDuration: 0,
    timerEndsAt: 0,
    pendingTimerSeconds: 0,
    timerPaused: false,
    pausedTimerSeconds: 0,
    timerStarting: false,
    cookRestarting: false,
    timerExtensionUpdating: false,
    timerStartFailed: false,
    activeSetPoint: null,
    timeAtTemperatureStartedAt: 0,
    timeAtTemperatureSeconds: 0,
    timeAtTemperaturePending: false,
    now: Date.now(),
    uiFrozen: false,
    frozenView: null,
  }

  public componentDidMount() {
    // The local clock keeps displays accurate between telemetry updates. Poll
    // often enough to start pending timers promptly after Joule reaches its
    // target, without turning the dashboard into a continuous BLE read loop.
    this.clockInterval = window.setInterval(() => {
      this.advanceMockCook()
      this.setState({ now: Date.now() })
    }, 1000)
    this.temperatureRefreshInterval = window.setInterval(() => {
      if (
        this.state.connected &&
        !this.state.developerMode &&
        !this.state.starting &&
        !this.state.timerStarting &&
        !this.state.timerExtensionUpdating &&
        !this.state.reconnecting
      ) {
        this.client.refreshLiveData().catch((error) => console.warn("Could not refresh Joule temperature.", error))
      }
    }, 5000)
  }

  public componentWillUnmount() {
    window.clearInterval(this.clockInterval)
    window.clearInterval(this.temperatureRefreshInterval)
    this.clearTimerExtensionUpdate()
    this.disconnectRequested = true
    this.client.disconnect()
  }

  public connect = async () => {
    this.setState({ connecting: true, error: "" })
    try {
      if (this.state.manufacturerData) this.client.setManufacturerData(this.state.manufacturerData)
      await this.client.connect(
        (status) => this.setState({ status }),
        (data: JouleData) => {
          const programIsActive = [1, 2, 3].indexOf(data.programStep) !== -1
          const preserveCookState = this.cookRestartInProgress
          if (programIsActive) this.cookRestartInProgress = false
          this.setState({
            data,
            connected: true,
            dataReceivedAt: Date.now(),
            setPoint: this.prefilledSetPoint(data),
            timerDuration: preserveCookState ? this.state.timerDuration : this.timerDuration(data),
            timerEndsAt: this.initialTimerEnd(data),
            activeSetPoint: data.setPoint === undefined ? this.state.activeSetPoint : data.setPoint,
            cookRestarting: programIsActive ? false : preserveCookState,
            // Joule reports a transient stopped program while it applies a
            // restart; wait for telemetry confirming the program is active
            // again before unfreezing the dashboard so nothing visibly resets.
            ...(programIsActive ? { uiFrozen: false, frozenView: null } : {}),
          })
        },
        this.handleConnectionLost,
      )
      this.setState({ connected: true, connecting: false })
    } catch (error) {
      this.setState({ connecting: false, error: error.message || String(error) })
    }
  }

  public start = async () => {
    this.setState({ starting: true, status: "Sending cook request...", error: "" })
    const input = parseFloat(this.state.setPoint)
    const setPoint = this.state.isCelsius ? input : (input - 32) / 1.8
    const cookTime = this.getEnteredCookTimeSeconds()
    if (!isFinite(setPoint) || setPoint < 0 || setPoint > 100) {
      this.setState({ starting: false, error: "Enter a target temperature from 0 to 100°C." })
      return
    }
    if (!isFinite(cookTime) || cookTime < 0 || cookTime > 86400) {
      this.setState({ starting: false, error: "Enter a cook time from 1 second to 24 hours." })
      return
    }
    if (this.state.developerMode) {
      this.startMockProgram(setPoint, cookTime)
      return
    }

    try {
      const startsTimerImmediately = cookTime > 0 && this.canStartTimer(setPoint)
      const timed = await this.client.startProgram(setPoint, startsTimerImmediately ? cookTime : 0)
      this.setState({
        error: "",
        status: timed ? "Timed cook started." : cookTime > 0 ? "Cook started. The timer will begin at the target temperature." : "Cook started without a device timer.",
        setPoint: input.toFixed(1),
        ...this.formattedTimerState(cookTime),
        timerDuration: cookTime,
        timerEndsAt: timed ? Date.now() + (cookTime * 1000) : 0,
        pendingTimerSeconds: timed ? 0 : cookTime,
        timerPaused: false,
        pausedTimerSeconds: 0,
        timerStartFailed: false,
        activeSetPoint: setPoint,
        timeAtTemperatureStartedAt: 0,
        timeAtTemperatureSeconds: 0,
        timeAtTemperaturePending: true,
      })
    } catch (error) {
      this.setState({ error: error.message || String(error) })
    } finally {
      this.setState({ starting: false })
    }
  }

  public stop = async () => {
    // A queued +5 update would restart a program, so discard it before stopping.
    this.clearTimerExtensionUpdate()
    if (this.state.developerMode) {
      this.setState({
        data: this.mockData(0),
        error: "",
        status: "Mock cook stopped.",
        timerDuration: 0,
        timerEndsAt: 0,
        pendingTimerSeconds: 0,
        timerPaused: false,
        pausedTimerSeconds: 0,
        timerStarting: false,
        timerStartFailed: false,
        activeSetPoint: null,
        timeAtTemperatureStartedAt: 0,
        timeAtTemperatureSeconds: 0,
        timeAtTemperaturePending: false,
      })
      return
    }
    this.setState({ starting: true, error: "" })
    try {
      await this.client.stopProgram()
      this.setState({
        error: "",
        status: "Cook stopped.",
        timerDuration: 0,
        timerEndsAt: 0,
        pendingTimerSeconds: 0,
        timerPaused: false,
        pausedTimerSeconds: 0,
        activeSetPoint: null,
        timeAtTemperatureStartedAt: 0,
        timeAtTemperatureSeconds: 0,
        timeAtTemperaturePending: false,
      })
    } catch (error) {
      this.setState({ error: error.message || String(error) })
    } finally {
      this.setState({ starting: false })
    }
  }

  public setTimer = async () => {
    // A manual timer value supersedes a queued +5 update.
    this.clearTimerExtensionUpdate()
    const cookTime = this.getEnteredCookTimeSeconds()
    if (!isFinite(cookTime) || cookTime <= 0 || cookTime > 86400) {
      this.setState({ error: "Enter a cook time from 1 second to 24 hours." })
      return
    }
    const startsTimerImmediately = this.canStartTimer(this.state.activeSetPoint)
    this.setState({
      error: "",
      status: startsTimerImmediately ? "Starting timer at the target temperature..." : "Timer saved. It will begin at the target temperature.",
      ...this.formattedTimerState(cookTime),
      timerDuration: cookTime,
      timerEndsAt: 0,
      pendingTimerSeconds: cookTime,
      timerPaused: false,
      pausedTimerSeconds: 0,
      timerStartFailed: false,
    })
  }

  // Computes every value the dashboard renders from cook/timer state. Pulled
  // out of render() so a snapshot can be captured and reused while the UI is
  // frozen across a Joule restart (see freezeDashboard/unfreezeDashboard).
  private deriveDashboardView(state: any) {
    const data: JouleData = state.data
    const temperature = data ? this.displayTemperature(data.bathTemp) : "Awaiting live data"
    const isCooking = data && (
      [1, 2, 3].indexOf(data.programStep) !== -1 ||
      state.cookRestarting ||
      this.cookRestartInProgress
    )
    const timeRemaining = state.timerEndsAt > 0
      ? Math.max(0, Math.ceil((state.timerEndsAt - state.now) / 1000))
      : data ? Math.max(0, data.timeRemaining - Math.floor((state.now - state.dataReceivedAt) / 1000)) : 0
    const timerDuration = state.timerDuration || (data && data.cookTime) || 0
    const hasTimer = isCooking && timerDuration > 0 && state.pendingTimerSeconds === 0 && !state.timerPaused
    const timerIsPending = isCooking && state.pendingTimerSeconds > 0
    const timerIsPaused = isCooking && state.timerPaused
    const displayedTimerSeconds = hasTimer
      ? timeRemaining
      : timerIsPaused
        ? state.pausedTimerSeconds
        : timerIsPending ? state.pendingTimerSeconds : 0
    const timerProgress = hasTimer || timerIsPending || timerIsPaused ? Math.min(1, displayedTimerSeconds / timerDuration) : 1
    const selectedTemperature = parseFloat(state.setPoint)
    const targetTemperature = state.isCelsius ? selectedTemperature : (selectedTemperature - 32) / 1.8
    const appliedTargetTemperature = isCooking && state.activeSetPoint !== null
      ? state.activeSetPoint
      : targetTemperature
    const hasReachedTarget = state.timeAtTemperatureStartedAt > 0 || state.timeAtTemperatureSeconds > 0
    const phase = this.cookPhase(isCooking, data, appliedTargetTemperature, hasReachedTarget)
    const isAtOrAboveTarget = this.isAtOrAboveTarget(state)
    const temperatureDirection = phase === "Preheating" ? "up" : phase === "Cooling" ? "down" : ""
    const timeAtTemperature = state.timeAtTemperatureSeconds +
      (state.timeAtTemperatureStartedAt > 0
        ? Math.max(0, Math.floor((state.now - state.timeAtTemperatureStartedAt) / 1000))
        : 0)
    const canUpdateTemperature = isCooking &&
      isFinite(targetTemperature) &&
      (state.activeSetPoint === null || Math.abs(targetTemperature - state.activeSetPoint) > 0.05)

    return {
      data, temperature, isCooking, timeRemaining, timerDuration, hasTimer, timerIsPending, timerIsPaused,
      displayedTimerSeconds, timerProgress, selectedTemperature, targetTemperature, appliedTargetTemperature,
      hasReachedTarget, phase, isAtOrAboveTarget, temperatureDirection, timeAtTemperature, canUpdateTemperature,
    }
  }

  // Restarting Joule's program (resuming a paused timer, moving from
  // preheating to an active timer, updating the target temperature, or
  // extending the timer) makes Joule briefly report a stopped program before
  // it confirms the new program. Rather than let the dashboard flash through
  // that transient "reset" state, freeze the dashboard's rendered values at
  // the moment the restart begins and only let them update again once fresh
  // telemetry confirms the program is active again (see unfreezeDashboard).
  private freezeDashboard() {
    if (this.state.developerMode || this.state.uiFrozen) return
    this.setState({ uiFrozen: true, frozenView: this.deriveDashboardView(this.state) })
  }

  private unfreezeDashboard(extraState: any = {}) {
    if (!this.state.uiFrozen) {
      this.setState(extraState)
      return
    }
    this.setState({ ...extraState, uiFrozen: false, frozenView: null })
  }

  public render() {
    const {
      data, temperature, isCooking, timerDuration, hasTimer, timerIsPending, timerIsPaused,
      displayedTimerSeconds, timerProgress, targetTemperature, phase, isAtOrAboveTarget,
      temperatureDirection, timeAtTemperature, canUpdateTemperature,
    } = this.state.uiFrozen && this.state.frozenView ? this.state.frozenView : this.deriveDashboardView(this.state)

    return (
      <div className="content">
        <header className="controller-header">
          <div>
            <p className="eyebrow">Bluetooth sous vide controller</p>
            <h1>Chrome Joule</h1>
          </div>
          <div className="header-controls">
            {DEVELOPER_MODE_ENABLED &&
              <button
                className={`developer-toggle ${this.state.developerMode ? "enabled" : ""}`}
                type="button"
                role="switch"
                aria-checked={this.state.developerMode}
                onClick={this.toggleDeveloperMode}
              >
                <span>Developer mode</span>
                <span className="developer-toggle-track"><span /></span>
              </button>}
            <button
              className={`theme-toggle ${this.props.darkMode ? "dark" : "light"}`}
              type="button"
              onClick={this.props.onToggleDarkMode}
              aria-label={`Switch to ${this.props.darkMode ? "light" : "dark"} mode`}
            >
              <span className="theme-toggle-track">
                <span className="theme-toggle-thumb">{this.props.darkMode ? "☾" : "☀"}</span>
              </span>
            </button>
          </div>
        </header>
        {this.state.showDisconnectConfirmation &&
          <div className="dialog-backdrop">
            <section className="panel disconnect-dialog" role="dialog" aria-modal="true" aria-labelledby="disconnect-dialog-title">
              <div className="panel-content">
                <h2 id="disconnect-dialog-title">Disconnect Joule?</h2>
                <p>
                  {this.state.developerMode
                    ? "This will end the simulated Joule connection."
                    : "This will remove the saved pairing key. You will need to pair your Joule again by pressing its top button before you can control it."}
                </p>
              </div>
              <div className="dialog-actions">
                <button className="btn btn-text" type="button" onClick={this.cancelDisconnect}>Cancel</button>
                <button className="btn btn-danger" type="button" onClick={this.confirmDisconnect}>Disconnect</button>
              </div>
            </section>
          </div>}
        {this.state.reconnecting &&
          <div className="dialog-backdrop">
            <section className="panel disconnect-dialog reconnect-dialog" role="dialog" aria-modal="true" aria-labelledby="reconnect-dialog-title">
              <div className="panel-content">
                <h2 id="reconnect-dialog-title">Reconnecting to Joule</h2>
                <p>{this.state.reconnectError || "Joule is applying the updated cook settings. The dashboard will reconnect shortly."}</p>
              </div>
              {this.state.reconnectError &&
                <div className="dialog-actions">
                  <button className="btn btn-primary" type="button" onClick={this.beginReconnection}>Retry connection</button>
                </div>}
            </section>
          </div>}
        {this.state.error &&
          <section className="panel status-banner">
            <div className="panel-content status-banner-text">{this.state.error}</div></section>}
        {!this.state.connected &&
          <section className="panel connection-card">
            <div className="panel-content connection-status">
              <h2>Connect your Joule</h2>
              <p>{this.state.status}</p>
            </div><div>
              <div className="panel-actions">
                <button className="btn btn-primary" onClick={this.connect} disabled={this.state.connecting}>{this.state.connecting ? "Connecting..." : "Connect Joule"}</button>
                <button className="btn btn-text" onClick={() => this.setState({ showAdvancedSettings: !this.state.showAdvancedSettings })}>Advanced</button>
              </div>
              {this.state.showAdvancedSettings &&
                <div className="panel-content"><label className="advanced-field"><span>Manufacturer data from nRF Connect</span><input type="text" value={this.state.manufacturerData} onChange={(e) => this.setState({ manufacturerData: e.target.value })} placeholder="01C0000031E8DE9349" /></label></div>}
            </div></section>}
        {this.state.connected &&
          <main className="cook-dashboard">
            <section className="panel dashboard-status">
              <div className="panel-content dashboard-card-text">
                <div className="status-heading">
                  <div>
                    <p className="eyebrow">Joule is connected</p>
                    <h2>{phase}</h2>
                  </div>
                  <div className="connection-actions">
                    <span className={`state-pill ${isCooking ? "active" : ""}`}>
                      {isCooking ? "Cook in progress" : "Ready"}
                    </span>
                    <button className="btn btn-disconnect" onClick={this.requestDisconnect}>Disconnect</button>
                  </div>
                </div>
                <p className="status-detail">{this.state.status}</p>
              </div></section>

            <div className="dashboard-grid">
              <section className={`panel temperature-panel ${phase.toLowerCase()}`}>
                <div className="panel-content dashboard-card-text">
                  <p className="panel-label">Current water temperature</p>
                  <div className="temperature-reading">
                    <strong>{temperature}</strong>
                    {temperatureDirection &&
                      <span
                        className={`temperature-direction ${temperatureDirection}`}
                        aria-label={temperatureDirection === "up" ? "Heating toward target" : "Cooling toward target"}
                        title={temperatureDirection === "up" ? "Heating toward target" : "Cooling toward target"}
                      >
                        {temperatureDirection === "up" ? "↗︎" : "↘︎"}
                      </span>}
                  </div>
                  <div className="temperature-summary">
                    <label className="setting-field">
                      <span>Set temperature</span>
                      <div>
                        <input
                          type="number"
                          inputMode="decimal"
                          value={this.state.setPoint}
                          onChange={(event) => this.setState({ setPoint: event.target.value })}
                          placeholder="Set temperature"
                          aria-label="Target temperature"
                        />
                        <div className="unit-switcher" role="group" aria-label="Temperature unit">
                          <button
                            type="button"
                            className={this.state.isCelsius ? "active" : ""}
                            onClick={() => this.setTemperatureUnit(true)}
                            aria-pressed={this.state.isCelsius}
                          >
                            °C
                          </button>
                          <button
                            type="button"
                            className={!this.state.isCelsius ? "active" : ""}
                            onClick={() => this.setTemperatureUnit(false)}
                            aria-pressed={!this.state.isCelsius}
                          >
                            °F
                          </button>
                        </div>
                      </div>
                    </label>
                  </div>
                </div>
                <div className="panel-actions">
                  {!isCooking &&
                    <button className="btn btn-primary" onClick={this.start} disabled={this.state.starting}>{this.state.starting ? "Starting..." : "Start"}</button>}
                  {isCooking &&
                    <button className="btn btn-primary" onClick={this.updateTemperature} disabled={this.state.starting || !canUpdateTemperature}>{this.state.starting ? "Updating..." : "Update temperature"}</button>}
                  {isCooking && <button className="btn btn-danger" onClick={this.stop} disabled={this.state.starting || this.state.timerExtensionUpdating}>Stop cook</button>}
                </div></section>

              <section className="panel timer-panel">
                <div className="panel-content dashboard-card-text">
                  <div className="at-temperature-content">
                    <div>
                      <p className="panel-label">Cook timer</p>
                      <p className="at-temperature-detail">
                        {hasTimer ? "remaining" : timerIsPaused ? "paused" : timerIsPending ? "Starts when the water reaches the target" : isCooking ? "No timer set" : "Start a cook to add a timer"}
                      </p>
                    </div>
                    <strong className="at-temperature-reading">
                      {hasTimer || timerIsPending || timerIsPaused ? this.formatDuration(displayedTimerSeconds) : "--:--"}
                    </strong>
                  </div>

                  {(hasTimer || timerIsPending || timerIsPaused) && (
                    <div className={`linear-timer-track ${hasTimer ? "counting" : "solid"} ${timerIsPending || timerIsPaused ? "paused" : ""}`}>
                      <div 
                        className="linear-timer-progress" 
                        style={{ width: `${timerProgress * 100}%` }}
                      ></div>
                    </div>
                  )}

                  <div className="setting-field timer-setting">
                    <span>Set timer <em>Optional</em></span>
                    <div className="timer-input-row">
                      <div className="timer-input">
                        <div className="timer-segmented-input" role="group" aria-label="Cook timer duration">
                          <div className="timer-segment">
                            <input
                              ref={(el) => { this.hoursInput = el }}
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              maxLength={2}
                              value={this.state.cookHours}
                              onChange={(event) => this.handleTimerSegmentChange("cookHours", event.target.value)}
                              onKeyDown={(event) => this.handleTimerKeyDown("cookHours", event)}
                              onPaste={this.handleTimerPaste}
                              placeholder="00"
                              aria-label="Hours"
                            />
                            <span className="segment-label">hr</span>
                          </div>
                          <span className="timer-separator" aria-hidden="true">:</span>
                          <div className="timer-segment">
                            <input
                              ref={(el) => { this.minutesInput = el }}
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              maxLength={2}
                              value={this.state.cookMinutes}
                              onChange={(event) => this.handleTimerSegmentChange("cookMinutes", event.target.value)}
                              onKeyDown={(event) => this.handleTimerKeyDown("cookMinutes", event)}
                              onPaste={this.handleTimerPaste}
                              placeholder="00"
                              aria-label="Minutes"
                            />
                            <span className="segment-label">min</span>
                          </div>
                          <span className="timer-separator" aria-hidden="true">:</span>
                          <div className="timer-segment">
                            <input
                              ref={(el) => { this.secondsInput = el }}
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              maxLength={2}
                              value={this.state.cookSeconds}
                              onChange={(event) => this.handleTimerSegmentChange("cookSeconds", event.target.value)}
                              onKeyDown={(event) => this.handleTimerKeyDown("cookSeconds", event)}
                              onPaste={this.handleTimerPaste}
                              placeholder="00"
                              aria-label="Seconds"
                            />
                            <span className="segment-label">sec</span>
                          </div>
                        </div>
                      </div>
                      {(hasTimer || timerIsPending) &&
                        <div className="timer-add-actions">
                          <button
                            className="btn btn-secondary timer-add-button"
                            type="button"
                            onClick={() => this.addMinutes(5)}
                            disabled={this.state.timerExtensionUpdating}
                          >
                            +5 min
                          </button>
                          <button
                            className="btn btn-secondary timer-add-button"
                            type="button"
                            onClick={() => this.addMinutes(30)}
                            disabled={this.state.timerExtensionUpdating}
                          >
                            +30 min
                          </button>
                        </div>}
                    </div>
                  </div>
                </div>
                {isCooking &&
                  <div className="panel-actions">
                    <button className="btn btn-primary" onClick={this.setTimer} disabled={this.state.starting || this.state.timerStarting || this.state.timerExtensionUpdating}>{this.state.timerStarting ? "Starting timer..." : timerIsPending || hasTimer || timerIsPaused ? "Update timer" : "Start timer"}</button>
                    {(hasTimer || timerIsPaused) &&
                      <button
                        className={`btn ${timerIsPaused ? "btn-resume" : "btn-pause"}`}
                        onClick={timerIsPaused ? this.resumeTimer : this.pauseTimer}
                        disabled={this.state.starting || this.state.timerStarting || this.state.timerExtensionUpdating}
                      >
                        {timerIsPaused ? "Resume" : "Pause"}
                      </button>}
                  </div>}
              </section>

              <section className="panel at-temperature-panel">
                <div className="panel-content dashboard-card-text">
                  <div className="at-temperature-content">
                    <div>
                      <p className="panel-label">Time at temperature</p>
                      <p className="at-temperature-detail">
                        {timeAtTemperature > 0
                          ? isAtOrAboveTarget ? "At or above the target temperature" : "Paused until the water reaches the target"
                          : isCooking ? "Starts when the water reaches the target" : "Starts during an active cook"}
                      </p>
                    </div>
                    <strong className="at-temperature-reading">
                      {timeAtTemperature > 0 ? this.formatDuration(timeAtTemperature) : "--:--"}
                    </strong>
                  </div>
                </div></section>

            </div>
          </main>}
      </div>
    )
  }

  private displayTemperature(celsius: number) {
    const value = this.state.isCelsius ? celsius : (celsius * 1.8) + 32
    return `${value.toFixed(1)}°${this.state.isCelsius ? "C" : "F"}`
  }

  private prefilledSetPoint(data: JouleData) {
    if (
      this.state.setPoint !== "" ||
      data.setPoint === undefined ||
      [1, 2, 3].indexOf(data.programStep) === -1
    ) return this.state.setPoint
    const setPoint = this.state.isCelsius ? data.setPoint : (data.setPoint * 1.8) + 32
    return setPoint.toFixed(1)
  }

  private timerDuration(data: JouleData) {
    if (!data || [1, 2, 3].indexOf(data.programStep) === -1) return 0
    return data.cookTime || this.state.timerDuration
  }

  private initialTimerEnd(data: JouleData) {
    if (this.state.timerEndsAt > 0 || !data || !data.cookTime || data.timeRemaining <= 0) {
      return this.state.timerEndsAt
    }
    return Date.now() + (data.timeRemaining * 1000)
  }

  private cookPhase(isCooking: boolean, data: JouleData, targetTemperature: number, hasReachedTarget: boolean) {
    if (!isCooking) return "Ready to preheat"
    if (!isFinite(targetTemperature)) return "Cooking"
    const temperatureTolerance = 0.3
    // Preheating ends only once Joule reaches the exact target. After that,
    // the tolerance band prevents minor normal temperature variation from
    // repeatedly switching the cook status back to Preheating.
    if (data.bathTemp < targetTemperature && (!hasReachedTarget || data.bathTemp < targetTemperature - temperatureTolerance)) {
      return "Preheating"
    }
    if (data.bathTemp > targetTemperature + temperatureTolerance) return "Cooling"
    return "Cooking"
  }

  private setTemperatureUnit = (isCelsius: boolean) => {
    if (this.state.isCelsius === isCelsius) return
    const value = parseFloat(this.state.setPoint)
    if (!isFinite(value)) {
      this.setState({ isCelsius })
      return
    }
    const converted = isCelsius ? (value - 32) / 1.8 : (value * 1.8) + 32
    this.setState({ isCelsius, setPoint: converted.toFixed(1) })
  }

  private updateTemperature = async () => {
    // Temperature changes restart Joule's program; do not let a delayed timer
    // update race that restart.
    this.clearTimerExtensionUpdate()
    const input = parseFloat(this.state.setPoint)
    const setPoint = this.state.isCelsius ? input : (input - 32) / 1.8
    if (!isFinite(setPoint) || setPoint < 0 || setPoint > 100) {
      this.setState({ error: "Enter a target temperature from 0 to 100°C." })
      return
    }

    const cookTime = this.state.timerEndsAt > 0
      ? this.remainingTimerSeconds()
      : this.state.pendingTimerSeconds
    const startsTimerImmediately = cookTime > 0 && this.canStartTimer(setPoint)
    const targetTemperatureIncreased = this.state.activeSetPoint === null || setPoint > this.state.activeSetPoint + 0.05
    const timeAtTemperatureState = targetTemperatureIncreased
      ? {
          timeAtTemperatureStartedAt: startsTimerImmediately ? Date.now() : 0,
          timeAtTemperatureSeconds: 0,
          timeAtTemperaturePending: !startsTimerImmediately,
        }
      : {
          timeAtTemperatureStartedAt: this.state.timeAtTemperatureStartedAt,
          timeAtTemperatureSeconds: this.state.timeAtTemperatureSeconds,
          timeAtTemperaturePending: this.state.timeAtTemperaturePending,
        }
    if (this.state.developerMode) {
      this.setState({
        data: this.mockData(1, setPoint, startsTimerImmediately ? cookTime : 0),
        setPoint: input.toFixed(1),
        activeSetPoint: setPoint,
        timerDuration: cookTime > 0 ? this.state.timerDuration || cookTime : 0,
        timerEndsAt: startsTimerImmediately ? Date.now() + (cookTime * 1000) : 0,
        pendingTimerSeconds: startsTimerImmediately ? 0 : cookTime,
        timerPaused: false,
        pausedTimerSeconds: 0,
        timerStartFailed: false,
        ...timeAtTemperatureState,
        error: "",
        status: "Mock target temperature updated.",
      })
      return
    }
    this.cookRestartInProgress = true
    this.freezeDashboard()
    this.setState({
      starting: true,
      cookRestarting: true,
      status: "Updating target temperature...",
      error: "",
    })
    try {
      const timed = await this.client.updateSetPoint(setPoint, startsTimerImmediately ? cookTime : 0)
      this.setState({
        setPoint: input.toFixed(1),
        activeSetPoint: setPoint,
        timerDuration: cookTime > 0 ? this.state.timerDuration || cookTime : 0,
        timerEndsAt: timed ? Date.now() + (cookTime * 1000) : 0,
        pendingTimerSeconds: timed ? 0 : cookTime,
        timerPaused: false,
        pausedTimerSeconds: 0,
        timerStartFailed: false,
        ...timeAtTemperatureState,
        error: timed || cookTime === 0 ? "" : "Joule restarted, but did not accept the remaining device timer.",
        status: timed ? "Temperature and timer updated." : "Temperature updated.",
      })
    } catch (error) {
      this.cookRestartInProgress = false
      this.unfreezeDashboard({ cookRestarting: false, error: error.message || String(error) })
    } finally {
      this.setState({ starting: false })
    }
  }

  private remainingTimerSeconds() {
    if (this.state.timerEndsAt > 0) return Math.max(0, Math.ceil((this.state.timerEndsAt - Date.now()) / 1000))
    const data: JouleData = this.state.data
    return Math.max(0, data.timeRemaining - Math.floor((Date.now() - this.state.dataReceivedAt) / 1000))
  }

  private pauseTimer = () => {
    // Joule does not expose a timer-pause command. Keep heating and freeze the
    // extension's countdown; resume will replace Joule's timer with this value.
    this.clearTimerExtensionUpdate()
    const remainingSeconds = this.remainingTimerSeconds()
    if (remainingSeconds <= 0) return

    this.setState({
      timerEndsAt: 0,
      timerPaused: true,
      pausedTimerSeconds: remainingSeconds,
      error: "",
      status: "Timer paused. Joule will continue holding the target temperature.",
    })
  }

  private resumeTimer = async () => {
    const remainingSeconds = this.state.pausedTimerSeconds
    if (remainingSeconds <= 0) return
    // setTimer restarts Joule and briefly reports a stopped program, which
    // clears timerDuration through the live-data callback. Preserve it first
    // so the resumed countdown remains visible and retains its progress.
    const timerDuration = this.state.timerDuration || remainingSeconds

    this.cookRestartInProgress = true
    this.freezeDashboard()
    this.setState({
      timerStarting: true,
      cookRestarting: true,
      error: "",
      status: "Resuming timer...",
    })
    try {
      if (!this.state.developerMode) {
        const timed = await this.client.setTimer(remainingSeconds)
        if (!timed) throw new Error("Joule restarted, but did not accept the resumed timer.")
      }
      this.setState({
        data: this.state.developerMode ? this.mockData(1, this.state.activeSetPoint, remainingSeconds) : this.state.data,
        timerDuration,
        timerEndsAt: Date.now() + (remainingSeconds * 1000),
        timerPaused: false,
        pausedTimerSeconds: 0,
        error: "",
        status: "Timer resumed.",
      })
    } catch (error) {
      this.cookRestartInProgress = false
      this.unfreezeDashboard({
        cookRestarting: false,
        error: error.message || String(error),
        status: "Timer remains paused.",
      })
    } finally {
      this.setState({ timerStarting: false })
    }
  }

  private addMinutes = (minutes: number) => {
    // Apply each press locally first so the timer remains responsive. A running
    // device timer is synchronized after the user's presses settle.
    const timerIsRunning = this.state.timerEndsAt > 0
    const currentSeconds = timerIsRunning ? this.remainingTimerSeconds() : this.state.pendingTimerSeconds
    if (currentSeconds <= 0) return

    const additionalSeconds = minutes * 60
    const timerDuration = (this.state.timerDuration || currentSeconds) + additionalSeconds
    const nextTimerSeconds = currentSeconds + additionalSeconds
    this.setState({
      ...this.formattedTimerState(timerDuration),
      timerDuration,
      timerEndsAt: timerIsRunning ? Date.now() + (nextTimerSeconds * 1000) : 0,
      pendingTimerSeconds: timerIsRunning ? 0 : nextTimerSeconds,
      error: "",
      status: timerIsRunning ? `Added ${minutes} minutes. Updating Joule shortly.` : `Added ${minutes} minutes to the pending timer.`,
    }, () => {
      if (timerIsRunning && !this.state.developerMode) this.queueTimerExtensionUpdate()
    })
  }

  private queueTimerExtensionUpdate() {
    this.clearTimerExtensionUpdate()
    // Do not delay an extension that would otherwise be sent near completion.
    if (this.remainingTimerSeconds() <= 30) {
      this.updateExtendedTimer()
      return
    }
    this.timerExtensionTimeout = window.setTimeout(() => this.updateExtendedTimer(), 30000)
  }

  private clearTimerExtensionUpdate() {
    if (this.timerExtensionTimeout) window.clearTimeout(this.timerExtensionTimeout)
    this.timerExtensionTimeout = 0
  }

  private updateExtendedTimer = async () => {
    this.timerExtensionTimeout = 0
    const remainingSeconds = this.remainingTimerSeconds()
    if (remainingSeconds <= 0) return

    this.cookRestartInProgress = true
    this.freezeDashboard()
    this.setState({ timerExtensionUpdating: true, cookRestarting: true })
    try {
      // Recalculate just before the request so the duration sent to Joule
      // reflects the time that elapsed during the debounce interval.
      await this.client.setTimer(remainingSeconds)
      this.setState({
        error: "",
        status: "Timer updated.",
        timerEndsAt: Date.now() + (remainingSeconds * 1000),
        timerPaused: false,
        pausedTimerSeconds: 0,
      })
    } catch (error) {
      this.cookRestartInProgress = false
      this.unfreezeDashboard({ cookRestarting: false, error: error.message || String(error) })
    } finally {
      this.setState({ timerExtensionUpdating: false })
    }
  }

  public componentDidUpdate(_previousProps, previousState) {
    // The service-worker alarm is the single completion-notification source.
    // Unlike an in-page countdown, it remains reliable after this tab closes.
    if (this.state.timerEndsAt !== previousState.timerEndsAt) {
      chrome.runtime.sendMessage(
        this.state.timerEndsAt > 0
          ? { type: "timer-scheduled", endsAt: this.state.timerEndsAt }
          : { type: "timer-cleared" },
      )
    }

    const isAtOrAboveTarget = this.isAtOrAboveTarget(this.state)
    // Accumulate only the periods where the bath is safely at or above its
    // active target. This also preserves elapsed time across lower targets.
    if (this.state.timeAtTemperaturePending && isAtOrAboveTarget) {
      this.setState({
        timeAtTemperatureStartedAt: Date.now(),
        timeAtTemperaturePending: false,
      })
      return
    }
    if (!this.state.timeAtTemperaturePending && this.state.timeAtTemperatureStartedAt > 0 && !isAtOrAboveTarget) {
      this.setState({
        timeAtTemperatureStartedAt: 0,
        timeAtTemperatureSeconds: this.state.timeAtTemperatureSeconds +
          Math.max(0, Math.floor((Date.now() - this.state.timeAtTemperatureStartedAt) / 1000)),
      })
      return
    }
    if (!this.state.timeAtTemperaturePending && this.state.timeAtTemperatureStartedAt === 0 && isAtOrAboveTarget) {
      this.setState({ timeAtTemperatureStartedAt: Date.now() })
      return
    }

    if (
      this.state.pendingTimerSeconds > 0 &&
      !this.state.timerStarting &&
      !this.state.timerStartFailed &&
      this.canStartTimer(this.state.activeSetPoint)
    ) this.startPendingTimer()
  }

  private canStartTimer(setPoint: number) {
    const data: JouleData = this.state.data
    return data && setPoint !== null && data.bathTemp >= setPoint
  }

  private isAtOrAboveTarget(state) {
    const data: JouleData = state.data
    return data &&
      state.activeSetPoint !== null &&
      data.bathTemp >= state.activeSetPoint
  }

  private startPendingTimer = async () => {
    const cookTime = this.state.pendingTimerSeconds
    if (cookTime <= 0) return

    this.cookRestartInProgress = true
    this.freezeDashboard()
    this.setState({ timerStarting: true, cookRestarting: true, error: "" })
    try {
      // Timers selected while preheating stay local until this point because
      // Joule otherwise begins counting down immediately.
      if (!this.state.developerMode) await this.client.setTimer(cookTime)
      this.setState({
        data: this.state.developerMode ? this.mockData(1, this.state.activeSetPoint, cookTime) : this.state.data,
        status: this.state.developerMode ? "Mock timer started." : "Timer started at the target temperature.",
        timerDuration: this.state.timerDuration || cookTime,
        timerEndsAt: Date.now() + (cookTime * 1000),
        pendingTimerSeconds: 0,
        timerPaused: false,
        pausedTimerSeconds: 0,
        timerStartFailed: false,
      })
    } catch (error) {
      this.cookRestartInProgress = false
      this.unfreezeDashboard({
        cookRestarting: false,
        error: error.message || String(error),
        timerStartFailed: true,
      })
    } finally {
      this.setState({ timerStarting: false })
    }
  }

  private toggleDeveloperMode = () => {
    if (!DEVELOPER_MODE_ENABLED) return

    if (this.state.developerMode) {
      this.setState({
        developerMode: false,
        connected: false,
        data: null,
        setPoint: "",
        cookHours: "",
        cookMinutes: "",
        cookSeconds: "",
        timerDuration: 0,
        timerEndsAt: 0,
        pendingTimerSeconds: 0,
        timerPaused: false,
        pausedTimerSeconds: 0,
        activeSetPoint: null,
        timeAtTemperatureStartedAt: 0,
        timeAtTemperatureSeconds: 0,
        timeAtTemperaturePending: false,
        status: "Connect directly to a nearby Joule over Bluetooth.",
      })
      return
    }

    this.disconnectRequested = true
    this.client.disconnect()
    this.setState({
      developerMode: true,
      connected: true,
      connecting: false,
      data: this.mockData(0),
      error: "",
      status: "Developer mode: simulated Joule connected.",
    })
  }

  private startMockProgram(setPoint: number, cookTime: number) {
    const input = parseFloat(this.state.setPoint)
    const startsTimerImmediately = cookTime > 0 && this.canStartTimer(setPoint)
    this.setState({
      data: this.mockData(1, setPoint, startsTimerImmediately ? cookTime : 0),
      error: "",
      status: startsTimerImmediately ? "Mock timed cook started." : cookTime > 0 ? "Mock cook started. The timer will begin at the target temperature." : "Mock cook started.",
      setPoint: input.toFixed(1),
      ...this.formattedTimerState(cookTime),
      timerDuration: cookTime,
      timerEndsAt: startsTimerImmediately ? Date.now() + (cookTime * 1000) : 0,
      pendingTimerSeconds: startsTimerImmediately ? 0 : cookTime,
      timerPaused: false,
      pausedTimerSeconds: 0,
      timerStartFailed: false,
      activeSetPoint: setPoint,
      timeAtTemperatureStartedAt: 0,
      timeAtTemperatureSeconds: 0,
      timeAtTemperaturePending: true,
      starting: false,
    })
  }

  private advanceMockCook() {
    const data: JouleData = this.state.data
    const setPoint = this.state.activeSetPoint
    if (!this.state.developerMode || !data || setPoint === null || data.programStep === 0) return

    // Developer mode changes temperature only; normal timer progression is
    // still driven by the same local deadline as a physical Joule timer.
    const difference = setPoint - data.bathTemp
    const bathTemp = Math.abs(difference) <= 2 ? setPoint : data.bathTemp + (difference > 0 ? 2 : -2)
    this.setState({ data: { ...data, bathTemp, sequenceNumber: data.sequenceNumber + 1 }, dataReceivedAt: Date.now() })
  }

  private mockData(programStep: number, setPoint?: number, cookTime = 0): JouleData {
    const existingData: JouleData = this.state.data
    return {
      bathTemp: existingData ? existingData.bathTemp : 21,
      programStep,
      timeRemaining: cookTime,
      feedId: 1,
      sequenceNumber: existingData ? existingData.sequenceNumber + 1 : 1,
      setPoint,
      cookTime,
    }
  }

  private requestDisconnect = () => this.setState({ showDisconnectConfirmation: true })

  private cancelDisconnect = () => this.setState({ showDisconnectConfirmation: false })

  private confirmDisconnect = () => {
    this.setState({ showDisconnectConfirmation: false })
    if (this.state.developerMode) {
      this.toggleDeveloperMode()
      return
    }
    this.disconnectRequested = true
    this.client.forgetPairing()
    this.client.disconnect()
  }

  private resetDisconnectedState = () => {
    this.clearTimerExtensionUpdate()
    this.cookRestartInProgress = false
    this.setState({
      connected: false,
      connecting: false,
      data: null,
      dataReceivedAt: 0,
      timerDuration: 0,
      timerEndsAt: 0,
      pendingTimerSeconds: 0,
      timerPaused: false,
      pausedTimerSeconds: 0,
      timerStarting: false,
      cookRestarting: false,
      timerExtensionUpdating: false,
      timerStartFailed: false,
      activeSetPoint: null,
      timeAtTemperatureStartedAt: 0,
      timeAtTemperatureSeconds: 0,
      timeAtTemperaturePending: false,
      showDisconnectConfirmation: false,
      reconnecting: false,
      reconnectError: "",
      starting: false,
      status: "Connect directly to a nearby Joule over Bluetooth.",
      uiFrozen: false,
      frozenView: null,
    })
  }

  private handleConnectionLost = () => {
    if (this.disconnectRequested || this.state.developerMode) {
      this.disconnectRequested = false
      this.resetDisconnectedState()
      return
    }
    this.beginReconnection()
  }

  private beginReconnection = () => {
    if (this.reconnectInProgress) return
    this.reconnectInProgress = true
    this.setState({
      reconnecting: true,
      reconnectError: "",
      error: "",
      status: "Connection interrupted. Reconnecting to Joule...",
    }, this.reconnectToJoule)
  }

  private reconnectToJoule = async () => {
    try {
      await this.client.reconnect()
      this.setState({
        connected: true,
        reconnecting: false,
        reconnectError: "",
        error: "",
        status: "Connected to Joule.",
      })
    } catch (error) {
      this.setState({
        reconnecting: true,
        reconnectError: error.message || String(error),
        status: "Joule could not reconnect automatically.",
      })
    } finally {
      this.reconnectInProgress = false
    }
  }

  private handleTimerSegmentChange = (field: "cookHours" | "cookMinutes" | "cookSeconds", value: string) => {
    const digits = value.replace(/\D/g, "").slice(0, 2)
    this.setState({ [field]: digits } as any, () => {
      if (digits.length === 2) {
        if (field === "cookHours" && this.minutesInput) {
          this.minutesInput.focus()
          this.minutesInput.select()
        } else if (field === "cookMinutes" && this.secondsInput) {
          this.secondsInput.focus()
          this.secondsInput.select()
        }
      }
    })
  }

  private handleTimerKeyDown = (field: "cookHours" | "cookMinutes" | "cookSeconds", event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && !this.state[field]) {
      if (field === "cookSeconds" && this.minutesInput) {
        this.minutesInput.focus()
      } else if (field === "cookMinutes" && this.hoursInput) {
        this.hoursInput.focus()
      }
    } else if (event.key === "ArrowRight" && event.currentTarget.selectionStart === event.currentTarget.value.length) {
      if (field === "cookHours" && this.minutesInput) {
        this.minutesInput.focus()
      } else if (field === "cookMinutes" && this.secondsInput) {
        this.secondsInput.focus()
      }
    } else if (event.key === "ArrowLeft" && event.currentTarget.selectionStart === 0) {
      if (field === "cookSeconds" && this.minutesInput) {
        this.minutesInput.focus()
      } else if (field === "cookMinutes" && this.hoursInput) {
        this.hoursInput.focus()
      }
    }
  }

  private handleTimerPaste = (event: React.ClipboardEvent<HTMLInputElement>) => {
    const text = event.clipboardData.getData("text").trim()
    if (text.includes(":")) {
      event.preventDefault()
      const parts = text.split(":").map((part) => part.replace(/\D/g, ""))
      if (parts.length === 2) {
        this.setState({
          cookHours: "00",
          cookMinutes: (`0${parts[0]}`).slice(-2),
          cookSeconds: (`0${parts[1]}`).slice(-2),
        })
      } else if (parts.length === 3) {
        this.setState({
          cookHours: (`0${parts[0]}`).slice(-2),
          cookMinutes: (`0${parts[1]}`).slice(-2),
          cookSeconds: (`0${parts[2]}`).slice(-2),
        })
      }
    }
  }

  private getEnteredCookTimeSeconds(): number {
    const { cookHours, cookMinutes, cookSeconds } = this.state
    if (!cookHours && !cookMinutes && !cookSeconds) return 0

    const h = cookHours ? parseInt(cookHours, 10) : 0
    const m = cookMinutes ? parseInt(cookMinutes, 10) : 0
    const s = cookSeconds ? parseInt(cookSeconds, 10) : 0

    if (isNaN(h) || isNaN(m) || isNaN(s)) return NaN
    if (h < 0 || m < 0 || s < 0) return NaN

    return (h * 3600) + (m * 60) + s
  }

  private formattedTimerState(totalSeconds: number) {
    if (totalSeconds <= 0) {
      return { cookHours: "", cookMinutes: "", cookSeconds: "" }
    }
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    return {
      cookHours: (`0${hours}`).slice(-2),
      cookMinutes: (`0${minutes}`).slice(-2),
      cookSeconds: (`0${seconds}`).slice(-2),
    }
  }

  private formatDuration(totalSeconds: number) {
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    const paddedMinutes = (`0${minutes}`).slice(-2)
    const paddedSeconds = (`0${seconds}`).slice(-2)
    return hours > 0 ? `${hours}:${paddedMinutes}:${paddedSeconds}` : `${minutes}:${paddedSeconds}`
  }
}

export default BleJouleView
