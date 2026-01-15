import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Library from './components/Library';
import Reader from './components/Reader';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/read/:bookId" element={<Reader />} />
      </Routes>
    </Router>
  );
}

export default App;
