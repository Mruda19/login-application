import { useState } from 'react';
import LoginForm from './components/LoginForm.jsx';
import RegisterForm from './components/RegisterForm.jsx';

function App() {
  const [mode, setMode] = useState('login'); // 'login' | 'register'

  return (
    <div className="card">
      <h1>{mode === 'login' ? 'Sign in' : 'Create account'}</h1>

      {mode === 'login' ? <LoginForm /> : <RegisterForm />}

      <p
        className="switch"
        onClick={() => setMode(mode === 'login' ? 'register' : 'login')}
      >
        {mode === 'login' ? 'No account? Register' : 'Already have an account? Sign in'}
      </p>
    </div>
  );
}

export default App;
