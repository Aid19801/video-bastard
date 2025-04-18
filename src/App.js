import { Routes, Route } from "react-router-dom"
import HomePage from "./pages/home"
import AboutPage from "./pages/about"
import './App.css';
import Nav from "./components/nav";

function App() {
  return (
    <div className="App">
      <Nav />
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/about" element={<AboutPage />} />
      </Routes>
    </div>
  );
}

export default App;
