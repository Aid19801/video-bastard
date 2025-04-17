import { Routes, Route, Link } from "react-router-dom"
import HomePage from "./pages/home"
import AboutPage from "./pages/about"
import './App.css';

function App() {
  return (
    <div className="App">
      <nav style={{ padding: 20, borderBottom: "5px solid blue" }}>
        <Link to="/" style={{ marginRight: 20 }}>Home</Link>
        <Link to="/about" style={{ marginRight: 20 }}>About</Link>
      </nav>

      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/about" element={<AboutPage />} />
      </Routes>
    </div>
  );
}

export default App;
