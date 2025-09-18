// state/maintenanceState.js
let MODE = (process.env.MAINTENANCE_MODE || 'off').toLowerCase(); 
// off | admin_only | full

function getMode() {
  return MODE;
}
function setMode(next) {
  if (!['off', 'admin_only', 'full'].includes(String(next))) return;
  MODE = String(next);
}

module.exports = { getMode, setMode };
