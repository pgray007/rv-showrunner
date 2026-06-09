import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* BrowserRouter keeps the app shareable through direct page URLs. */}
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
