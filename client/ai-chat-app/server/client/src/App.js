import logo from './logo.svg';
import './App.css';

function App() {
  return (
    <div className="App">
      <header className="App-header">
        <img src={logo} className="App-logo" alt="logo" />
        <p>
          Edit <code>src/App.js</code> and save to reload.
        </p>
        <a
          className="App-link"
          href="https://reactjs.org"
          target="_blank"
          rel="noopener noreferrer"
        >
          Learn React
        </a>
      </header>
    </div>
  );
}

import { useEffect, useState } from "react";
import socket from "./socket";

function App() {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);

  useEffect(() => {
    socket.on("receiveMessage", msg => {
      setMessages(prev => [...prev, msg]);
    });
  }, []);

  const sendMessage = () => {
    socket.emit("sendMessage", message);
    setMessage("");
  };

  return (
    <div style={{ padding: 20 }}>
      <h2>AI Chat App</h2>

      <div>
        {messages.map((m, i) => (
          <p key={i}>{m}</p>
        ))}
      </div>

      <input
        value={message}
        onChange={e => setMessage(e.target.value)}
      />
      <button onClick={sendMessage}>Send</button>
    </div>
  );
}

export default App;