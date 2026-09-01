import { Card, CardActions, CardText } from "material-ui/Card"
import FlatButton from "material-ui/FlatButton"
import RaisedButton from "material-ui/RaisedButton"
import TextField from "material-ui/TextField"
import * as React from "react"
import JouleBleClient, { JouleData } from "./JouleBleClient"

interface BleJouleViewProps {
  darkMode: boolean
  onToggleDarkMode: () => void
}

class BleJouleView extends React.Component<BleJouleViewProps, any> {
  private client = new JouleBleClient()
  private clockInterval: number
  private temperatureRefreshInterval: number

  public state = {
    status: "Connect directly to a nearby Joule over Bluetooth.",
    connected: false,
    connecting: false,
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
    activeSetPoint: null,
    timeAtTemperatureStartedAt: 0,
    timeAtTemperaturePending: false,
    targetTemperaturePhaseObserved: false,
    now: Date.now(),
  }

  public componentDidMount() {
    // BLE telemetry is refreshed less often than the displayed clocks.
    this.clockInterval = window.setInterval(() => this.setState({ now: Date.now() }), 1000)
    this.temperatureRefreshInterval = window.setInterval(() => {
      if (this.state.connected && !this.state.starting) {
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

    try {
      const timed = await this.client.startProgram(setPoint, cookTime)
      this.setState({
        error: "",
        status: timed ? "Timed cook started." : "Cook started without a device timer.",
        timerDuration: timed ? cookTime : 0,
        timerEndsAt: timed ? Date.now() + (cookTime * 1000) : 0,
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
    if (this.currentCookPhase() !== "Cooking" && !window.confirm(
      "The device timer will begin immediately, but the water has not reached the target temperature yet. Start the timer anyway?",
    )) return

    this.setState({ starting: true, status: "Restarting cook with timer...", error: "" })
    try {
      const timed = await this.client.setTimer(cookTime)
      this.setState({
        error: timed ? "" : "Joule restarted, but did not accept the device timer.",
        status: timed ? "Timed cook started." : "Cook restarted without a device timer.",
        timerDuration: timed ? cookTime : 0,
        timerEndsAt: timed ? Date.now() + (cookTime * 1000) : 0,
      })
    } catch (error) {
      this.setState({ error: error.message || String(error) })
    } finally {
      this.setState({ starting: false })
    }
  }

  public render() {
    const data: JouleData = this.state.data
    const temperature = data ? this.displayTemperature(data.bathTemp) : "Awaiting live data"
    const isCooking = data && [1, 2, 3].indexOf(data.programStep) !== -1
    const timeRemaining = this.state.timerEndsAt > 0
      ? Math.max(0, Math.ceil((this.state.timerEndsAt - this.state.now) / 1000))
      : data ? Math.max(0, data.timeRemaining - Math.floor((this.state.now - this.state.dataReceivedAt) / 1000)) : 0
    const timerDuration = this.state.timerDuration || (data && data.cookTime) || 0
    const hasTimer = isCooking && timerDuration > 0
    const timerProgress = hasTimer ? Math.min(1, timeRemaining / timerDuration) : 1
    const timerCircumference = 439.8
    const unit = this.state.isCelsius ? "C" : "F"
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
        </header>
        {this.state.error &&
          <Card className="status-banner">
            <CardText className="status-banner-text">{this.state.error}</CardText>
          </Card>}
        {!this.state.connected &&
          <Card className="connection-card">
            <CardText className="connection-status">
              <h2>Connect your Joule</h2>
              <p>{this.state.status}</p>
            </CardText>
            <div>
              <CardActions>
                <RaisedButton label={this.state.connecting ? "Connecting..." : "Connect Joule"} onClick={this.connect} disabled={this.state.connecting} primary />
                <FlatButton
                  label="Advanced"
                  onClick={() => this.setState({ showAdvancedSettings: !this.state.showAdvancedSettings })}
                />
              </CardActions>
              {this.state.showAdvancedSettings &&
                <CardText>
                  <TextField
                    value={this.state.manufacturerData}
                    onChange={(_, value) => this.setState({ manufacturerData: value })}
                    floatingLabelText="Manufacturer data from nRF Connect"
                    hintText="01C0000031E8DE9349"
                    fullWidth
                  />
                </CardText>}
            </div>
          </Card>}
        {this.state.connected &&
          <main className="cook-dashboard">
            <Card className="dashboard-status">
              <CardText className="dashboard-card-text">
                <div className="status-heading">
                  <div>
                    <p className="eyebrow">Joule is connected</p>
                    <h2>{phase}</h2>
                  </div>
                  <span className={`state-pill ${isCooking ? "active" : ""}`}>
                    {isCooking ? "Cook in progress" : "Ready"}
                  </span>
                </div>
                <p className="status-detail">{this.state.status}</p>
              </CardText>
            </Card>

            <div className="dashboard-grid">
              <Card className="temperature-panel">
                <CardText className="dashboard-card-text">
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
                    <span>Target</span>
                    <b>{this.state.activeSetPoint !== null
                      ? this.displayTemperature(this.state.activeSetPoint)
                      : "Not set"}</b>
                  </div>
                </CardText>
              </Card>

              <Card className="timer-panel">
                <CardText className="dashboard-card-text">
                  <p className="panel-label">Cook timer</p>
                  <div className={`cook-timer ${hasTimer ? "counting" : "solid"}`}>
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
                      <strong>{hasTimer ? this.formatDuration(timeRemaining) : "--:--"}</strong>
                    </div>
                  </div>
                  <p className="timer-detail">
                    {hasTimer ? "remaining" : isCooking ? "No timer set" : "Start a cook to add a timer"}
                  </p>
                </CardText>
              </Card>

              <Card className="at-temperature-panel">
                <CardText className="dashboard-card-text">
                  <p className="panel-label">Time at temperature</p>
                  <strong className="at-temperature-reading">
                    {this.state.timeAtTemperatureStartedAt > 0 ? this.formatDuration(timeAtTemperature) : "--:--"}
                  </strong>
                  <p className="at-temperature-detail">
                    {this.state.timeAtTemperatureStartedAt > 0
                      ? "Since the water reached the target"
                      : isCooking ? "Starts when the water reaches the target" : "Starts during an active cook"}
                  </p>
                </CardText>
              </Card>

              <Card className="controls-panel">
                <CardText className="dashboard-card-text">
                  <p className="panel-label">Cook controls</p>
                  <div className="cook-settings">
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
                        <button type="button" className="unit-button" onClick={this.toggleTemperatureUnit}>
                          °{unit}
                        </button>
                      </div>
                    </label>
                    <label className="setting-field">
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
                </CardText>
                <CardActions className="cook-actions">
                  {!isCooking &&
                    <RaisedButton label={this.state.starting ? "Starting..." : "Start preheat"} onClick={this.start} disabled={this.state.starting} primary />}
                  {isCooking &&
                    <RaisedButton label={this.state.starting ? "Setting timer..." : hasTimer ? "Update timer" : "Start timer"} onClick={this.setTimer} disabled={this.state.starting} primary />}
                  {isCooking &&
                    <RaisedButton label={this.state.starting ? "Updating..." : "Update temperature"} onClick={this.updateTemperature} disabled={this.state.starting || !canUpdateTemperature} primary />}
                  {isCooking && <RaisedButton label="Stop cook" onClick={this.stop} disabled={this.state.starting} secondary />}
                  <FlatButton label="Disconnect" onClick={this.disconnect} />
                </CardActions>
              </Card>
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

  private toggleTemperatureUnit = () => {
    const value = parseFloat(this.state.setPoint)
    const isCelsius = !this.state.isCelsius
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
    const cookTime = data && data.timeRemaining > 0
      ? this.remainingTimerSeconds()
      : 0
    this.setState({ starting: true, status: "Updating target temperature...", error: "" })
    try {
      const timed = await this.client.updateSetPoint(setPoint, cookTime)
      this.setState({
        activeSetPoint: setPoint,
        timerDuration: timed ? cookTime : 0,
        timerEndsAt: timed ? Date.now() + (cookTime * 1000) : 0,
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

  public componentDidUpdate(_previousProps, previousState) {
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

  private disconnect = () => {
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
