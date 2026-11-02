import { createRoot } from 'react-dom/client'
import '../shared/theme.css'
import './overlay.css'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
