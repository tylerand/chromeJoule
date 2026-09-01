declare const chrome: any

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
  if (alarm.name === timerCompletionAlarm) showTimerCompletionNotification()
})