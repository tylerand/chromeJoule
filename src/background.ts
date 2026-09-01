declare const chrome: any

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("controller.html") })
})

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "timer-complete") return

  chrome.notifications.create("joule-timer-complete", {
    type: "basic",
    iconUrl: "icon.png",
    title: "Joule timer complete",
    message: "Your cook timer has reached zero.",
  })
})