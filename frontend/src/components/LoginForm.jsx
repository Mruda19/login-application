import { useState } from 'react';
import { loginUser } from '../api.js';

function LoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');

  const handleLogin = async (e) => {
    e.preventDefault();
    setMessage('Signing in...');
    try {
      await loginUser(username, password);
      setMessage('Login successful! A confirmation email has been queued.');
    } catch (err) {
      setMessage(err.message);
    }
  };

  return (
    <form onSubmit={handleLogin}>
      <label>Username</label>
      <input
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        required
      />

      <label>Password</label>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />

      <button type="submit">Login</button>
      <p id="message">{message}</p>
    </form>
  );
}

export default LoginForm;
