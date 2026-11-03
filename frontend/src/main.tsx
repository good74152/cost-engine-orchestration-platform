import {createRoot} from 'react-dom/client';
import {PrimeReactProvider} from 'primereact/api';
import '@fontsource-variable/inter';
import {App} from './app/app';
import {DemoProvider} from './app/demo-context';
import {primeOptions} from './ui/prime-theme';
import './styles/main.css';

createRoot(document.getElementById('root')!).render(<PrimeReactProvider value={primeOptions}><DemoProvider><App/></DemoProvider></PrimeReactProvider>);
