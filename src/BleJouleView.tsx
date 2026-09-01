import * as React from "react"
import JouleBleClient, { JouleData } from "./JouleBleClient"

declare const chrome: any

interface BleJouleViewProps {
  darkMode: boolean
  onToggleDarkMode: () => void
}

class BleJouleView extends React.Component<BleJouleViewProps, any> {
  private client = new JouleBleClient()
  private clockInterval: number
  private temperatureRefreshInterval: number
  private timerCompletionNotified = false

  public state = {
    status: "Connect directly to a nearby Joule over Bluetooth.",
    connected: false,
    connecting: false,
    developerMode: false,
    setPoint: "",
    cookTime: "",
    isCelsius: false,
    data: null,
    error: "",
    manufacturerData: localStorage.getItem("chrome-joule-manufacturer-data") || "",
    showAdvancedSettings: false,
    starting: false,
    dataReceivedAt: 0,
    timerDuration: 0,
    timerEndsAt: 0,
    pendingTimerSeconds: 0,
    timerStarting: false,
    timerStartFailed: false,
    activeSetPoint: null,
    timeAtTemperatureStartedAt: 0,
    timeAtTemperaturePending: false,
    targetTemperaturePhaseObserved: false,
    now: Date.now(),
  }

  public componentDidMount() {
    // BLE telemetry is refreshed less often than the displayed clocks.
    this.clockInterval = window.setInterval(() => {
      this.advanceMockCook()
      this.setState({ now: Date.now() })
    }, 1000)
    this.temperatureRefreshInterval = window.setInterval(() => {
      if (this.state.connected && !this.state.developerMode && !this.state.starting) {
        this.client.refreshLiveData().catch((error) => console.warn("Could not refresh Joule temperature.", error))
      }
    }, 20000)
  }

  public componentWillUnmount() {
    window.clearInterval(this.clockInterval)
    window.clearInterval(this.temperatureRefreshInterval)
    this.client.disconnect()
  }

  public connect = async () => {
    this.setState({ connecting: true, error: "" })
    try {
      if (this.state.manufacturerData) this.client.setManufacturerData(this.state.manufacturerData)
      await this.client.connect(
        (status) => this.setState({ status }),
        (data: JouleData) => this.setState({
          data,
          connected: true,
          dataReceivedAt: Date.now(),
          setPoint: this.prefilledSetPoint(data),
          timerDuration: this.timerDuration(data),
          timerEndsAt: this.initialTimerEnd(data),
          activeSetPoint: data.setPoint === undefined ? this.state.activeSetPoint : data.setPoint,
        }),
        () => this.setState({
          connected: false,
          connecting: false,
          data: null,
          dataReceivedAt: 0,
          timerDuration: 0,
          timerEndsAt: 0,
          pendingTimerSeconds: 0,
          timerStarting: false,
          timerStartFailed: false,
          activeSetPoint: null,
          timeAtTemperatureStartedAt: 0,
          timeAtTemperaturePending: false,
          targetTemperaturePhaseObserved: false,
          starting: false,
          status: "Connect directly to a nearby Joule over Bluetooth.",
        }),
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
    const cookTime = this.state.cookTime === "" ? 0 : parseInt(this.state.cookTime, 10) * 60
    if (!isFinite(setPoint) || setPoint < 0 || setPoint > 100) {
      this.setState({ starting: false, error: "Enter a target temperature from 0 to 100°C." })
      return
    }
    if (!isFinite(cookTime) || cookTime < 0 || cookTime > 86400) {
      this.setState({ starting: false, error: "Enter a cook time from 1 to 1,440 minutes." })
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
        timerDuration: cookTime,
        timerEndsAt: timed ? Date.now() + (cookTime * 1000) : 0,
        pendingTimerSeconds: timed ? 0 : cookTime,
        timerStartFailed: false,
        activeSetPoint: setPoint,
        timeAtTemperatureStartedAt: 0,
        timeAtTemperaturePending: true,
        targetTemperaturePhaseObserved: false,
      })
    } catch (error) {
      this.setState({ error: error.message || String(error) })
    } finally {
      this.setState({ starting: false })
    }
  }

  public stop = async () => {
    if (this.state.developerMode) {
      this.setState({
        data: this.mockData(0),
        error: "",
        status: "Mock cook stopped.",
        timerDuration: 0,
        timerEndsAt: 0,
        pendingTimerSeconds: 0,
        timerStarting: false,
        timerStartFailed: false,
        activeSetPoint: null,
        timeAtTemperatureStartedAt: 0,
        timeAtTemperaturePending: false,
        targetTemperaturePhaseObserved: false,
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
        activeSetPoint: null,
        timeAtTemperatureStartedAt: 0,
        timeAtTemperaturePending: false,
        targetTemperaturePhaseObserved: false,
      })
    } catch (error) {
      this.setState({ error: error.message || String(error) })
    } finally {
      this.setState({ starting: false })
    }
  }

  public setTimer = async () => {
    const cookTime = parseInt(this.state.cookTime, 10) * 60
    if (!isFinite(cookTime) || cookTime <= 0 || cookTime > 86400) {
      this.setState({ error: "Enter a cook time from 1 to 1,440 minutes." })
      return
    }
    const startsTimerImmediately = this.canStartTimer(this.state.activeSetPoint)
    this.setState({
      error: "",
      status: startsTimerImmediately ? "Starting timer at the target temperature..." : "Timer saved. It will begin at the target temperature.",
      timerDuration: cookTime,
      timerEndsAt: 0,
      pendingTimerSeconds: cookTime,
      timerStartFailed: false,
    })
  }

  public render() {
    const data: JouleData = this.state.data
    const temperature = data ? this.displayTemperature(data.bathTemp) : "Awaiting live data"
    const isCooking = data && [1, 2, 3].indexOf(data.programStep) !== -1
    const timeRemaining = this.state.timerEndsAt > 0
      ? Math.max(0, Math.ceil((this.state.timerEndsAt - this.state.now) / 1000))
      : data ? Math.max(0, data.timeRemaining - Math.floor((this.state.now - this.state.dataReceivedAt) / 1000)) : 0
    const timerDuration = this.state.timerDuration || (data && data.cookTime) || 0
    const hasTimer = isCooking && timerDuration > 0 && this.state.pendingTimerSeconds === 0
    const timerIsPending = isCooking && this.state.pendingTimerSeconds > 0
    const displayedTimerSeconds = hasTimer ? timeRemaining : timerIsPending ? this.state.pendingTimerSeconds : 0
    const timerProgress = hasTimer || timerIsPending ? Math.min(1, displayedTimerSeconds / timerDuration) : 1
    const timerCircumference = 439.8
    const selectedTemperature = parseFloat(this.state.setPoint)
    const targetTemperature = this.state.isCelsius ? selectedTemperature : (selectedTemperature - 32) / 1.8
    const appliedTargetTemperature = isCooking && this.state.activeSetPoint !== null
      ? this.state.activeSetPoint
      : targetTemperature
    const phase = this.cookPhase(isCooking, data, appliedTargetTemperature)
    const temperatureDirection = isCooking && data && isFinite(appliedTargetTemperature)
      ? data.bathTemp < appliedTargetTemperature - 0.3 ? "up" : data.bathTemp > appliedTargetTemperature + 0.3 ? "down" : "steady"
      : ""
    const timeAtTemperature = this.state.timeAtTemperatureStartedAt > 0
      ? Math.max(0, Math.floor((this.state.now - this.state.timeAtTemperatureStartedAt) / 1000))
      : 0
    const canUpdateTemperature = isCooking &&
      isFinite(targetTemperature) &&
      (this.state.activeSetPoint === null || Math.abs(targetTemperature - this.state.activeSetPoint) > 0.05)

    return (
      <div className="content">
        <header className="controller-header">
          <div>
            <p className="eyebrow">Bluetooth sous vide controller</p>
            <h1>Chrome Joule</h1>
          </div>
          <div className="header-controls">
            <button
              className={`developer-toggle ${this.state.developerMode ? "enabled" : ""}`}
              type="button"
              role="switch"
              aria-checked={this.state.developerMode}
              onClick={this.toggleDeveloperMode}
            >
              <span>Developer mode</span>
              <span className="developer-toggle-track"><span /></span>
            </button>
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
                    <button className="btn btn-text" onClick={this.disconnect}>Disconnect</button>
                  </div>
                </div>
                <p className="status-detail">{this.state.status}</p>
              </div></section>

            <div className="dashboard-grid">
              <section className={`panel temperature-panel ${phase.toLowerCase()}`}>
                <div className="panel-content dashboard-card-text">
                  <p className="panel-label">Live water temperature</p>
                  <div className="temperature-reading">
                    <strong>{temperature}</strong>
                    {temperatureDirection && temperatureDirection !== "steady" &&
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
                    <button className="btn btn-primary" onClick={this.start} disabled={this.state.starting}>{this.state.starting ? "Starting..." : "Start preheat"}</button>}
                  {isCooking &&
                    <button className="btn btn-primary" onClick={this.updateTemperature} disabled={this.state.starting || !canUpdateTemperature}>{this.state.starting ? "Updating..." : "Update temperature"}</button>}
                  {isCooking && <button className="btn btn-danger" onClick={this.stop} disabled={this.state.starting}>Stop cook</button>}
                </div></section>

              <section className="panel timer-panel">
                <div className="panel-content dashboard-card-text">
                  <p className="panel-label">Cook timer</p>
                  <div className={`cook-timer ${hasTimer ? "counting" : "solid"} ${timerIsPending ? "paused" : ""}`}>
                    <svg className="cook-timer-ring" viewBox="0 0 160 160" aria-hidden="true">
                      <circle className="cook-timer-track" cx="80" cy="80" r="70" />
                      <circle
                        className="cook-timer-progress"
                        cx="80"
                        cy="80"
                        r="70"
                        style={{
                          strokeDasharray: timerCircumference,
                          strokeDashoffset: timerCircumference * (1 - timerProgress),
                        }}
                      />
                    </svg>
                    <div className="cook-timer-content">
                      <strong>{hasTimer || timerIsPending ? this.formatDuration(displayedTimerSeconds) : "--:--"}</strong>
                    </div>
                  </div>
                  <p className="timer-detail">
                    {hasTimer ? "remaining" : timerIsPending ? "Starts when the water reaches the target" : isCooking ? "No timer set" : "Start a cook to add a timer"}
                  </p>
                  <label className="setting-field timer-setting">
                    <span>Set timer <em>Optional</em></span>
                    <div>
                      <input
                        type="number"
                        inputMode="numeric"
                        min="1"
                        value={this.state.cookTime}
                        onChange={(event) => this.setState({ cookTime: event.target.value })}
                        placeholder="Add a timer"
                        aria-label="Cook time in minutes"
                      />
                      <b>min</b>
                    </div>
                  </label>
                </div>
                {isCooking &&
                  <div className="panel-actions">
                    <button className="btn btn-primary" onClick={this.setTimer} disabled={this.state.starting || this.state.timerStarting}>{this.state.timerStarting ? "Starting timer..." : timerIsPending || hasTimer ? "Update timer" : "Start timer"}</button>
                  </div>}
              </section>

              <section className="panel at-temperature-panel">
                <div className="panel-content dashboard-card-text">
                  <div className="at-temperature-content">
                    <div>
                      <p className="panel-label">Time at temperature</p>
                      <p className="at-temperature-detail">
                        {this.state.timeAtTemperatureStartedAt > 0
                          ? "Since the water reached the target"
                          : isCooking ? "Starts when the water reaches the target" : "Starts during an active cook"}
                      </p>
                    </div>
                    <strong className="at-temperature-reading">
                      {this.state.timeAtTemperatureStartedAt > 0 ? this.formatDuration(timeAtTemperature) : "--:--"}
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

  private cookPhase(isCooking: boolean, data: JouleData, targetTemperature: number) {
    if (!isCooking) return "Ready to preheat"
    if (!isFinite(targetTemperature)) return "Cooking"
    const temperatureTolerance = 0.3
    if (data.bathTemp < targetTemperature - temperatureTolerance) return "Preheating"
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
    const input = parseFloat(this.state.setPoint)
    const setPoint = this.state.isCelsius ? input : (input - 32) / 1.8
    if (!isFinite(setPoint) || setPoint < 0 || setPoint > 100) {
      this.setState({ error: "Enter a target temperature from 0 to 100°C." })
      return
    }

    const data: JouleData = this.state.data
    const cookTime = this.state.timerEndsAt > 0
      ? this.remainingTimerSeconds()
      : this.state.pendingTimerSeconds
    const startsTimerImmediately = cookTime > 0 && this.canStartTimer(setPoint)
    if (this.state.developerMode) {
      this.setState({
        data: this.mockData(1, setPoint, startsTimerImmediately ? cookTime : 0),
        activeSetPoint: setPoint,
        timerDuration: cookTime > 0 ? this.state.timerDuration || cookTime : 0,
        timerEndsAt: startsTimerImmediately ? Date.now() + (cookTime * 1000) : 0,
        pendingTimerSeconds: startsTimerImmediately ? 0 : cookTime,
        timerStartFailed: false,
        timeAtTemperatureStartedAt: 0,
        timeAtTemperaturePending: true,
        targetTemperaturePhaseObserved: false,
        error: "",
        status: "Mock target temperature updated.",
      })
      return
    }
    this.setState({ starting: true, status: "Updating target temperature...", error: "" })
    try {
      const timed = await this.client.updateSetPoint(setPoint, startsTimerImmediately ? cookTime : 0)
      this.setState({
        activeSetPoint: setPoint,
        timerDuration: cookTime > 0 ? this.state.timerDuration || cookTime : 0,
        timerEndsAt: timed ? Date.now() + (cookTime * 1000) : 0,
        pendingTimerSeconds: timed ? 0 : cookTime,
        timerStartFailed: false,
        timeAtTemperatureStartedAt: 0,
        timeAtTemperaturePending: true,
        targetTemperaturePhaseObserved: false,
        error: timed || cookTime === 0 ? "" : "Joule restarted, but did not accept the remaining device timer.",
        status: timed ? "Temperature and timer updated." : "Temperature updated.",
      })
    } catch (error) {
      this.setState({ error: error.message || String(error) })
    } finally {
      this.setState({ starting: false })
    }
  }

  private remainingTimerSeconds() {
    if (this.state.timerEndsAt > 0) return Math.max(0, Math.ceil((this.state.timerEndsAt - Date.now()) / 1000))
    const data: JouleData = this.state.data
    return Math.max(0, data.timeRemaining - Math.floor((Date.now() - this.state.dataReceivedAt) / 1000))
  }

  private timerSecondsForState(state) {
    const data: JouleData = state.data
    if (state.timerEndsAt > 0) return Math.max(0, Math.ceil((state.timerEndsAt - state.now) / 1000))
    if (!data) return 0
    return Math.max(0, data.timeRemaining - Math.floor((state.now - state.dataReceivedAt) / 1000))
  }

  public componentDidUpdate(_previousProps, previousState) {
    const previousTimerSeconds = this.timerSecondsForState(previousState)
    const currentTimerSeconds = this.timerSecondsForState(this.state)
    if (currentTimerSeconds > 0) this.timerCompletionNotified = false
    if (previousTimerSeconds > 0 && currentTimerSeconds === 0 && !this.timerCompletionNotified) {
      this.timerCompletionNotified = true
      chrome.runtime.sendMessage({ type: "timer-complete" })
    }
    if (this.state.timerEndsAt !== previousState.timerEndsAt) {
      chrome.runtime.sendMessage(
        this.state.timerEndsAt > 0
          ? { type: "timer-scheduled", endsAt: this.state.timerEndsAt }
          : { type: "timer-cleared" },
      )
    }

    const previousPhase = this.cookPhaseForState(previousState)
    const currentPhase = this.currentCookPhase()
    // A target change must first produce a heating or cooling phase before its
    // elapsed-at-temperature clock can start on the following Cooking phase.
    if (
      this.state.timeAtTemperaturePending &&
      !this.state.targetTemperaturePhaseObserved &&
      (currentPhase === "Preheating" || currentPhase === "Cooling")
    ) {
      this.setState({ targetTemperaturePhaseObserved: true })
      return
    }
    if (
      this.state.timeAtTemperaturePending &&
      this.state.targetTemperaturePhaseObserved &&
      currentPhase === "Cooking" &&
      (previousPhase === "Preheating" || previousPhase === "Cooling") &&
      this.state.timeAtTemperatureStartedAt === 0
    ) this.setState({
      timeAtTemperatureStartedAt: Date.now(),
      timeAtTemperaturePending: false,
    })

    if (
      this.state.pendingTimerSeconds > 0 &&
      !this.state.timerStarting &&
      !this.state.timerStartFailed &&
      this.canStartTimer(this.state.activeSetPoint)
    ) this.startPendingTimer()
  }

  private cookPhaseForState(state) {
    const data: JouleData = state.data
    const isCooking = data && [1, 2, 3].indexOf(data.programStep) !== -1
    const selectedTemperature = parseFloat(state.setPoint)
    const targetTemperature = state.isCelsius ? selectedTemperature : (selectedTemperature - 32) / 1.8
    const appliedTargetTemperature = isCooking && state.activeSetPoint !== null
      ? state.activeSetPoint
      : targetTemperature
    return this.cookPhase(isCooking, data, appliedTargetTemperature)
  }

  private currentCookPhase() {
    return this.cookPhaseForState(this.state)
  }

  private canStartTimer(setPoint: number) {
    const data: JouleData = this.state.data
    // Match the Cook phase threshold so both clocks begin from the same point.
    return data && setPoint !== null && data.bathTemp >= setPoint - 0.3
  }

  private startPendingTimer = async () => {
    const cookTime = this.state.pendingTimerSeconds
    if (cookTime <= 0) return

    this.setState({ timerStarting: true, error: "" })
    try {
      if (!this.state.developerMode) await this.client.setTimer(cookTime)
      this.setState({
        data: this.state.developerMode ? this.mockData(1, this.state.activeSetPoint, cookTime) : this.state.data,
        status: this.state.developerMode ? "Mock timer started." : "Timer started at the target temperature.",
        timerDuration: this.state.timerDuration || cookTime,
        timerEndsAt: Date.now() + (cookTime * 1000),
        pendingTimerSeconds: 0,
        timerStartFailed: false,
      })
    } catch (error) {
      this.setState({ error: error.message || String(error), timerStartFailed: true })
    } finally {
      this.setState({ timerStarting: false })
    }
  }

  private toggleDeveloperMode = () => {
    if (this.state.developerMode) {
      this.setState({
        developerMode: false,
        connected: false,
        data: null,
        setPoint: "",
        cookTime: "",
        timerDuration: 0,
        timerEndsAt: 0,
        activeSetPoint: null,
        timeAtTemperatureStartedAt: 0,
        timeAtTemperaturePending: false,
        targetTemperaturePhaseObserved: false,
        status: "Connect directly to a nearby Joule over Bluetooth.",
      })
      return
    }

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
    const startsTimerImmediately = cookTime > 0 && this.canStartTimer(setPoint)
    this.setState({
      data: this.mockData(1, setPoint, startsTimerImmediately ? cookTime : 0),
      error: "",
      status: startsTimerImmediately ? "Mock timed cook started." : cookTime > 0 ? "Mock cook started. The timer will begin at the target temperature." : "Mock cook started.",
      timerDuration: cookTime,
      timerEndsAt: startsTimerImmediately ? Date.now() + (cookTime * 1000) : 0,
      pendingTimerSeconds: startsTimerImmediately ? 0 : cookTime,
      timerStartFailed: false,
      activeSetPoint: setPoint,
      timeAtTemperatureStartedAt: 0,
      timeAtTemperaturePending: true,
      targetTemperaturePhaseObserved: false,
      starting: false,
    })
  }

  private advanceMockCook() {
    const data: JouleData = this.state.data
    const setPoint = this.state.activeSetPoint
    if (!this.state.developerMode || !data || setPoint === null || data.programStep === 0) return

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

  private disconnect = () => {
    if (this.state.developerMode) {
      this.toggleDeveloperMode()
      return
    }
    this.client.disconnect()
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
