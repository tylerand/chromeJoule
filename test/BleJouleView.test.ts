// Unit tests for the pure calculation/formatting helpers on BleJouleView.
//
// BleJouleView is a React component, but the methods under test here read
// only `this.state`/`this.props` and return a value - they do not touch the
// DOM, Bluetooth, or timers. Object.create(BleJouleView.prototype) creates an
// instance without running the constructor (which would need `localStorage`
// and a live JouleBleClient), so each test can attach just the state shape
// the method under test needs and call it directly.
import BleJouleView from "../src/BleJouleView"
import { JouleData } from "../src/JouleBleClient"

function makeView(state: any): any {
  const instance = Object.create((BleJouleView as any).prototype)
  instance.state = state
  instance.cookRestartInProgress = false
  return instance
}

function jouleData(overrides: Partial<JouleData> = {}): JouleData {
  return {
    bathTemp: 60,
    programStep: 0,
    timeRemaining: 0,
    feedId: 1,
    sequenceNumber: 1,
    ...overrides,
  }
}

describe("displayTemperature", () => {
  it("renders Celsius as-is when isCelsius is true", () => {
    const view = makeView({ isCelsius: true })
    expect(view.displayTemperature(60)).toBe("60.0°C")
  })

  it("converts to Fahrenheit when isCelsius is false", () => {
    const view = makeView({ isCelsius: false })
    expect(view.displayTemperature(0)).toBe("32.0°F")
    expect(view.displayTemperature(100)).toBe("212.0°F")
  })
})

describe("formatDuration", () => {
  const view = makeView({})

  it("omits the hours segment under an hour", () => {
    expect(view.formatDuration(65)).toBe("1:05")
  })

  it("includes the hours segment at or above an hour", () => {
    expect(view.formatDuration(3661)).toBe("1:01:01")
  })

  it("formats zero seconds as 0:00", () => {
    expect(view.formatDuration(0)).toBe("0:00")
  })
})

describe("formattedTimerState", () => {
  const view = makeView({})

  it("returns blank fields for zero or negative durations", () => {
    expect(view.formattedTimerState(0)).toEqual({ cookHours: "", cookMinutes: "", cookSeconds: "" })
    expect(view.formattedTimerState(-5)).toEqual({ cookHours: "", cookMinutes: "", cookSeconds: "" })
  })

  it("zero-pads hours/minutes/seconds to two digits", () => {
    expect(view.formattedTimerState(5)).toEqual({ cookHours: "00", cookMinutes: "00", cookSeconds: "05" })
    expect(view.formattedTimerState(3725)).toEqual({ cookHours: "01", cookMinutes: "02", cookSeconds: "05" })
  })
})

describe("getEnteredCookTimeSeconds", () => {
  it("returns 0 when every field is blank", () => {
    const view = makeView({ cookHours: "", cookMinutes: "", cookSeconds: "" })
    expect(view.getEnteredCookTimeSeconds()).toBe(0)
  })

  it("combines hours, minutes, and seconds into a total", () => {
    const view = makeView({ cookHours: "1", cookMinutes: "2", cookSeconds: "3" })
    expect(view.getEnteredCookTimeSeconds()).toBe((1 * 3600) + (2 * 60) + 3)
  })

  it("treats missing individual fields as 0", () => {
    const view = makeView({ cookHours: "", cookMinutes: "5", cookSeconds: "" })
    expect(view.getEnteredCookTimeSeconds()).toBe(300)
  })

  it("returns NaN for a negative field", () => {
    const view = makeView({ cookHours: "-1", cookMinutes: "0", cookSeconds: "0" })
    expect(view.getEnteredCookTimeSeconds()).toBeNaN()
  })

  it("returns NaN for a non-numeric field", () => {
    const view = makeView({ cookHours: "abc", cookMinutes: "0", cookSeconds: "0" })
    expect(view.getEnteredCookTimeSeconds()).toBeNaN()
  })
})

describe("canStartTimer", () => {
  it("is false with no live data", () => {
    const view = makeView({ data: null })
    expect(view.canStartTimer(60)).toBeFalsy()
  })

  it("is false with a null setPoint", () => {
    const view = makeView({ data: jouleData({ bathTemp: 60 }) })
    expect(view.canStartTimer(null)).toBe(false)
  })

  it("is true once the bath has reached the target", () => {
    const view = makeView({ data: jouleData({ bathTemp: 60 }) })
    expect(view.canStartTimer(60)).toBe(true)
    expect(view.canStartTimer(59)).toBe(true)
  })

  it("is false while still below the target", () => {
    const view = makeView({ data: jouleData({ bathTemp: 58 }) })
    expect(view.canStartTimer(60)).toBe(false)
  })
})

describe("isAtOrAboveTarget", () => {
  it("is false with no live data or no active target", () => {
    expect(makeView({ data: null, activeSetPoint: 60 }).isAtOrAboveTarget({ data: null, activeSetPoint: 60 })).toBeFalsy()
    const view = makeView({})
    expect(view.isAtOrAboveTarget({ data: jouleData({ bathTemp: 60 }), activeSetPoint: null })).toBe(false)
  })

  it("is true once bathTemp meets or exceeds the active target", () => {
    const view = makeView({})
    expect(view.isAtOrAboveTarget({ data: jouleData({ bathTemp: 60 }), activeSetPoint: 60 })).toBe(true)
    expect(view.isAtOrAboveTarget({ data: jouleData({ bathTemp: 61 }), activeSetPoint: 60 })).toBe(true)
    expect(view.isAtOrAboveTarget({ data: jouleData({ bathTemp: 59 }), activeSetPoint: 60 })).toBe(false)
  })
})

describe("remainingTimerSeconds", () => {
  it("counts down from a local timerEndsAt deadline", () => {
    const now = Date.now()
    const view = makeView({ timerEndsAt: now + 10000 })
    jest.spyOn(Date, "now").mockReturnValue(now)
    expect(view.remainingTimerSeconds()).toBe(10)
    ;(Date.now as jest.Mock).mockRestore()
  })

  it("never goes negative past the deadline", () => {
    const now = Date.now()
    const view = makeView({ timerEndsAt: now - 10000 })
    expect(view.remainingTimerSeconds()).toBe(0)
  })

  it("falls back to Joule's reported timeRemaining, adjusted for elapsed time, when no local deadline is set", () => {
    const receivedAt = Date.now() - 5000
    const view = makeView({ timerEndsAt: 0, data: jouleData({ timeRemaining: 100 }), dataReceivedAt: receivedAt })
    expect(view.remainingTimerSeconds()).toBe(95)
  })
})

describe("timeAtTemperatureElapsed", () => {
  it("returns the accumulated total when not currently accumulating", () => {
    const view = makeView({})
    expect(view.timeAtTemperatureElapsed({ timeAtTemperatureSeconds: 42, timeAtTemperatureStartedAt: 0 })).toBe(42)
  })

  it("adds elapsed time since timeAtTemperatureStartedAt", () => {
    const now = Date.now()
    const view = makeView({})
    const elapsed = view.timeAtTemperatureElapsed({
      timeAtTemperatureSeconds: 10,
      timeAtTemperatureStartedAt: now - 5000,
      now,
    })
    expect(elapsed).toBe(15)
  })
})

describe("cookPhase", () => {
  const view = makeView({})

  it("is 'Ready to preheat' when not cooking", () => {
    expect(view.cookPhase(false, null, 60, false)).toBe("Ready to preheat")
  })

  it("is 'Cooking' when no finite target temperature is set", () => {
    expect(view.cookPhase(true, jouleData({ bathTemp: 60 }), NaN, false)).toBe("Cooking")
  })

  it("is 'Preheating' below target before it has ever been reached", () => {
    expect(view.cookPhase(true, jouleData({ bathTemp: 55 }), 60, false)).toBe("Preheating")
  })

  it("is 'Cooking' once at the exact target", () => {
    expect(view.cookPhase(true, jouleData({ bathTemp: 60 }), 60, false)).toBe("Cooking")
  })

  it("tolerates minor dips below target after it has been reached (stays Cooking)", () => {
    expect(view.cookPhase(true, jouleData({ bathTemp: 59.8 }), 60, true)).toBe("Cooking")
  })

  it("returns to 'Preheating' if the temperature drops meaningfully below target after being reached", () => {
    expect(view.cookPhase(true, jouleData({ bathTemp: 59.5 }), 60, true)).toBe("Preheating")
  })

  it("is 'Cooling' when meaningfully above target", () => {
    expect(view.cookPhase(true, jouleData({ bathTemp: 60.5 }), 60, true)).toBe("Cooling")
  })
})

describe("prefilledSetPoint", () => {
  it("leaves a manually-entered setPoint untouched", () => {
    const view = makeView({ setPoint: "70.0", isCelsius: true })
    expect(view.prefilledSetPoint(jouleData({ programStep: 1, setPoint: 60 }))).toBe("70.0")
  })

  it("prefills from Joule's reported program setPoint while a program is active", () => {
    const view = makeView({ setPoint: "", isCelsius: true })
    expect(view.prefilledSetPoint(jouleData({ programStep: 1, setPoint: 60 }))).toBe("60.0")
  })

  it("converts to Fahrenheit for display when not in Celsius mode", () => {
    const view = makeView({ setPoint: "", isCelsius: false })
    expect(view.prefilledSetPoint(jouleData({ programStep: 2, setPoint: 0 }))).toBe("32.0")
  })

  it("does not prefill outside the active program steps (1, 2, 3)", () => {
    const view = makeView({ setPoint: "", isCelsius: true })
    expect(view.prefilledSetPoint(jouleData({ programStep: 0, setPoint: 60 }))).toBe("")
  })
})

describe("timerDuration", () => {
  const view = makeView({ timerDuration: 42 })

  it("is 0 with no data or an inactive program step", () => {
    expect(view.timerDuration(null)).toBe(0)
    expect(view.timerDuration(jouleData({ programStep: 0, cookTime: 100 }))).toBe(0)
  })

  it("prefers Joule's reported cookTime while a program is active", () => {
    expect(view.timerDuration(jouleData({ programStep: 1, cookTime: 100 }))).toBe(100)
  })

  it("falls back to the locally-tracked timerDuration when Joule reports none", () => {
    expect(view.timerDuration(jouleData({ programStep: 1, cookTime: 0 }))).toBe(42)
  })
})

describe("initialTimerEnd", () => {
  it("keeps an existing local deadline once one is set", () => {
    const view = makeView({ timerEndsAt: 12345 })
    expect(view.initialTimerEnd(jouleData({ cookTime: 100, timeRemaining: 50 }))).toBe(12345)
  })

  it("derives a deadline from Joule's reported timeRemaining when none is set locally", () => {
    const now = Date.now()
    jest.spyOn(Date, "now").mockReturnValue(now)
    const view = makeView({ timerEndsAt: 0 })
    expect(view.initialTimerEnd(jouleData({ cookTime: 100, timeRemaining: 50 }))).toBe(now + 50000)
    ;(Date.now as jest.Mock).mockRestore()
  })

  it("stays 0 when there is no active device timer", () => {
    const view = makeView({ timerEndsAt: 0 })
    expect(view.initialTimerEnd(jouleData({ cookTime: 0, timeRemaining: 0 }))).toBe(0)
  })
})

describe("deriveDashboardView", () => {
  // This drives the dashboard's frozen/live rendering across a Joule restart
  // (see freezeDashboard/unfreezeDashboard); it is the most behaviorally
  // important pure function in the file, so it gets the most thorough coverage.
  function baseState(overrides: any = {}) {
    return {
      data: jouleData({ bathTemp: 60, programStep: 1 }),
      cookRestarting: false,
      timerEndsAt: 0,
      now: Date.now(),
      dataReceivedAt: Date.now(),
      timerDuration: 1800,
      pendingTimerSeconds: 0,
      timerPaused: false,
      pausedTimerSeconds: 0,
      setPoint: "60.0",
      isCelsius: true,
      activeSetPoint: 60,
      timeAtTemperatureStartedAt: 0,
      timeAtTemperatureSeconds: 0,
      ...overrides,
    }
  }

  it("reports not cooking with no live data", () => {
    const view = makeView({})
    const result = view.deriveDashboardView(baseState({ data: null }))
    expect(result.isCooking).toBeFalsy()
    expect(result.temperature).toBe("Awaiting live data")
  })

  it("reports cooking when programStep indicates an active program", () => {
    const view = makeView({})
    const result = view.deriveDashboardView(baseState())
    expect(result.isCooking).toBe(true)
  })

  it("reports cooking during a restart even if the last data point looked stopped", () => {
    const view = makeView({})
    const result = view.deriveDashboardView(baseState({
      data: jouleData({ bathTemp: 60, programStep: 0 }),
      cookRestarting: true,
    }))
    expect(result.isCooking).toBe(true)
  })

  it("computes a running timer's remaining seconds from timerEndsAt", () => {
    const now = Date.now()
    const view = makeView({})
    const result = view.deriveDashboardView(baseState({ timerEndsAt: now + 30000, now }))
    expect(result.hasTimer).toBe(true)
    expect(result.timeRemaining).toBe(30)
    expect(result.displayedTimerSeconds).toBe(30)
  })

  it("reports a pending timer distinctly from a running one", () => {
    const view = makeView({})
    const result = view.deriveDashboardView(baseState({ pendingTimerSeconds: 600, timerDuration: 600 }))
    expect(result.hasTimer).toBe(false)
    expect(result.timerIsPending).toBe(true)
    expect(result.displayedTimerSeconds).toBe(600)
  })

  it("reports a paused timer distinctly from a running one", () => {
    const view = makeView({})
    const result = view.deriveDashboardView(baseState({ timerPaused: true, pausedTimerSeconds: 300 }))
    expect(result.hasTimer).toBe(false)
    expect(result.timerIsPaused).toBe(true)
    expect(result.displayedTimerSeconds).toBe(300)
  })

  it("flags canUpdateTemperature only when the entered target differs from the active one", () => {
    const view = makeView({})
    const same = view.deriveDashboardView(baseState({ setPoint: "60.0", activeSetPoint: 60 }))
    const different = view.deriveDashboardView(baseState({ setPoint: "62.0", activeSetPoint: 60 }))
    expect(same.canUpdateTemperature).toBe(false)
    expect(different.canUpdateTemperature).toBe(true)
  })
})
