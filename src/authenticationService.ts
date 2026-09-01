import { CSApiClient } from "./circulatorSdk"
import { csConfig } from "./constants"
import rootLogger from "./rootLogger"

class AuthenticationService {
  public userInfo: {
    email: string,
    id: number,
    name: string,
    slug: string,
    token: string,
    logged_in?: boolean,
  }

  private headers: any = { "Content-Type": "application/x-www-form-urlencoded" }
  private authenticationApi = new CSApiClient.AuthenticationApi(csConfig.chefstepsEndpoint, rootLogger)

  public async checkSession() {
    const response = await fetch(
      this.authenticationApi.baseUrl + this.authenticationApi.endpoints.sessionMe,
      { credentials: "include" },
    )

    if (!response.ok) {
      throw new Error(`Unable to check ChefSteps session (${response.status})`)
    }

    const userInfo = await response.json()
    this.userInfo = !userInfo.token && userInfo.logged_in === false ? null : userInfo
    return this.userInfo
  }

  public async getUserInfo() {
    if (this.userInfo) {
      return this.userInfo
    }

    return this.checkSession()
  }

  // TODO. Has a different API response from endpoints.sessionMe.
  public async login(email, password) {
    await this.authenticationApi.loginWithEmail(email, password).then((response) => {
      this.userInfo = response
      return this.userInfo
    })

    return this.checkSession()
  }

  public getCallerAddress(userToken) {
    const hexAddress = userToken ? JSON.parse(atob(userToken.split(".")[1])).a : "aabbaabbaabbaabb"
    return hexAddress
  }
}

export default new AuthenticationService()