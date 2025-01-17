import React from "react";
import ReactDOM from "react-dom";
import App from "./Archive/App";
import Provider from "../components/Provider";

ReactDOM.render(
  <React.StrictMode>
    <Provider>
      <App />
    </Provider>
  </React.StrictMode>,
  document.getElementById("root")
);
