import {createRoot} from 'react-dom/client';
import {BrowserRouter} from 'react-router-dom';
import {App} from './app/app';
import {DemoProvider} from './app/demo-context';
import './styles/main.css';
createRoot(document.getElementById('root')!).render(<BrowserRouter><DemoProvider><App/></DemoProvider></BrowserRouter>);
