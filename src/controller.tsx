import MuiThemeProvider from "material-ui/styles/MuiThemeProvider"
import getMuiTheme from "material-ui/styles/getMuiTheme"
import darkBaseTheme from "material-ui/styles/baseThemes/darkBaseTheme"
import lightBaseTheme from "material-ui/styles/baseThemes/lightBaseTheme"
import * as React from "react"
import * as ReactDOM from "react-dom"
import BleJouleView from "./BleJouleView"

class Main extends React.Component<{}, { darkMode: boolean }> {
  public state = { darkMode: true }

  public render() {
    const darkMode = this.state.darkMode
    return (
      <MuiThemeProvider muiTheme={getMuiTheme(darkMode ? darkBaseTheme : lightBaseTheme)}>
        <div className={`controller ${darkMode ? "dark" : "light"}`}>
          <BleJouleView
            darkMode={darkMode}
            onToggleDarkMode={() => this.setState({ darkMode: !darkMode })}
          />
        </div>
      </MuiThemeProvider>
    )
  }
}

ReactDOM.render(<Main />, document.getElementById("content"))
