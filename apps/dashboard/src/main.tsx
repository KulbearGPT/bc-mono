import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Dashboard root element is missing.');
}

const runtimeEnvironment = root.dataset.businessEnvironment;
const businessEnvironment = runtimeEnvironment === 'SANDBOX' || runtimeEnvironment === 'PRODUCTION'
  ? runtimeEnvironment
  : undefined;

createRoot(root).render(<App publicBusinessEnvironment={businessEnvironment} />);
