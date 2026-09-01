import * as React from "react"
import * as ReactDOM from "react-dom"
import BleJouleView from "./BleJouleView"

class Main extends React.Component<{}, { darkMode: boolean }> {
  public state = { darkMode: true }

  public render() {
    const darkMode = this.state.darkMode
    return (
      <div className={darkMode ? "controller dark" : "controller light"}>
        <BleJouleView
          darkMode={darkMode}
          onToggleDarkMode={() => this.setState({ darkMode: !darkMode })}
        />
      </div>
    )
  }
}

ReactDOM.render(<Main />, document.getElementById("content"))
