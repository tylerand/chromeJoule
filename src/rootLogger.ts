import { CSLogging, Uuid } from "./circulatorSdk"

export default CSLogging.getRootLogger().child({
  appSessionId: Uuid.v4(),
  appBuildFlavor: "production",
  appVersionNumber: "2.52.2",
})