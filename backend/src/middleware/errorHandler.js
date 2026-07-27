// Centralized error handler - keeps controllers free of try/catch boilerplate
// for unexpected errors.
function errorHandler(err, req, res, next) {
  console.error(err);
  res.status(500).json({ message: 'Internal server error' });
}

module.exports = errorHandler;
