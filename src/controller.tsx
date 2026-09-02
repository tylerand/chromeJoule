import * as React from "react"
import { createRoot } from "react-dom/client"
import BleJouleView from "./BleJouleView"

// Theme state belongs at the application root so the controller can remain
// focused on the Joule connection and cook state.
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

const container = document.getElementById("content")

if (!container) throw new Error("Controller mount element was not found.")

createRoot(container).render(<Main />)
