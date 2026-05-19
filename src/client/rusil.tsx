import './index.css';
import { createRoot } from 'react-dom/client';

const RusilPage = () => <h1 className="text-3xl font-bold p-6">Hello World</h1>;

createRoot(document.getElementById('root')!).render(<RusilPage />);
