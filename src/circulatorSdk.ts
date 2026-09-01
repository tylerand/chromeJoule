import "./bundle.js"

interface CirculatorSdkGlobals {
  CirculatorSDK: any
  CSApiClient: any
  CSLogging: any
  Q: any
  Uuid: any
}

const sdk = window as typeof window & CirculatorSdkGlobals

export const { CirculatorSDK, CSApiClient, CSLogging, Q, Uuid } = sdk
