declare const chrome: any

// The alarm and notification share an ID so each completed timer has one
// replaceable notification.
const timerCompletionAlarm = "joule-timer-complete"

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("controller.html") })
})

const showTimerCompletionNotification = () => {
  const createNotification = () => chrome.notifications.create(timerCompletionAlarm, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon-128.png"),
    title: "Joule timer complete",
    message: "Your cook timer has reached zero.",
  }, () => {
    if (chrome.runtime.lastError) {
      console.error("Could not show timer-complete notification.", chrome.runtime.lastError.message)
    }
  })

  // Windows treats a notification with an existing ID as an update and does
  // not show a new toast. Clearing it first guarantees a fresh alert.
  chrome.notifications.clear(timerCompletionAlarm, () => {
    if (chrome.runtime.lastError) {
      console.error("Could not clear the prior timer notification.", chrome.runtime.lastError.message)
    }
    createNotification()
  })
}

chrome.runtime.onMessage.addListener((message) => {
  // The controller mirrors its current deadline so Chrome can wake this worker
  // and notify after the controller tab has closed.
  if (message.type === "timer-scheduled") {
    chrome.alarms.create(timerCompletionAlarm, { when: message.endsAt })
    return
  }

  if (message.type === "timer-cleared") {
    chrome.alarms.clear(timerCompletionAlarm)
  }
})

chrome.alarms.onAlarm.addListener((alarm) => {
  // Chrome wakes the service worker for its own scheduled alarm.
  if (alarm.name === timerCompletionAlarm) showTimerCompletionNotification()
})