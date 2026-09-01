declare const chrome: any

// Keep the alarm name and notification ID identical so a timely foreground
// notification replaces the background-alarm fallback instead of duplicating it.
const timerCompletionAlarm = "joule-timer-complete"

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("controller.html") })
})

const showTimerCompletionNotification = () => {
  chrome.notifications.create(timerCompletionAlarm, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon.png"),
    title: "Joule timer complete",
    message: "Your cook timer has reached zero.",
  }).catch((error) => console.error("Could not show timer-complete notification.", error))
}

chrome.runtime.onMessage.addListener((message) => {
  // The controller owns the visible countdown and tells the service worker when
  // its deadline changes. Alarms continue running when the controller tab closes.
  if (message.type === "timer-scheduled") {
    chrome.alarms.create(timerCompletionAlarm, { when: message.endsAt })
    return
  }

  if (message.type === "timer-cleared") {
    chrome.alarms.clear(timerCompletionAlarm)
    return
  }

  if (message.type !== "timer-complete") return

  chrome.alarms.clear(timerCompletionAlarm)
  showTimerCompletionNotification()
})

chrome.alarms.onAlarm.addListener((alarm) => {
  // A timer completion can be missed by a throttled or closed controller page.
  if (alarm.name === timerCompletionAlarm) showTimerCompletionNotification()
})