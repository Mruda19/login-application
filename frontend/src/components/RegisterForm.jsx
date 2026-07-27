import { useState } from 'react';
import { registerUser } from '../api.js';

function RegisterForm() {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState('');

  const handleRegister = async (e) => {
    e.preventDefault();
    setMessage('Creating account...');
    try {
      await registerUser(username, email, password);
      setMessage('Account created. You can log in now.');
    } catch (err) {
      setMessage(err.message);
    }
  };

  return (
    <form onSubmit={handleRegister}>
      <label>Username</label>
      <input
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        required
      />

      <label>Email</label>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />

      <label>Password</label>
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />

      <button type="submit">Create account</button>
      <p id="message">{message}</p>
    </form>
  );
}

export default RegisterForm;
