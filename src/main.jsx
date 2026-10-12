import { StrictMode, Component } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { fontFaceCss, UI_FONTS } from './utils/fonts'
// import { registerSW } from 'virtual:pwa-register'

// The UI fonts come with the app (see utils/fonts). Defined from JS so the
// URLs resolve against the page, the same way the reader's do.
const fontFaces = document.createElement('style')
fontFaces.textContent = fontFaceCss(UI_FONTS, 'swap')
document.head.appendChild(fontFaces)

// Versions before the fonts were bundled cached Google Fonts at runtime.
if ('caches' in window) {
  for (const name of ['google-fonts-cache', 'gstatic-fonts-cache']) {
    caches.delete(name).catch(() => {})
  }
}

// registerSW({ immediate: true })

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Uncaught error:", error, errorInfo);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: '2rem', color: 'red', background: '#330000', minHeight: '100vh' }}>
          <h1>Something went wrong.</h1>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
            {this.state.error && this.state.error.toString()}
            <br />
            {this.state.errorInfo && this.state.errorInfo.componentStack}
          </pre>
        </div>
      );
    }

    return this.props.children;
  }
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
