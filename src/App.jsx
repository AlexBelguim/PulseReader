import React from 'react';
import { HashRouter as Router, Routes, Route } from 'react-router-dom';
import Library from './components/Library';
import Reader from './components/Reader';
import AudioPlayer from './components/AudioPlayer';

function App() {
  return (
    <Router>
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/read/:bookId" element={<Reader />} />
        <Route path="/listen/:bookId" element={<AudioPlayer />} />
      </Routes>
    </Router>
  );
}

export default App;
