const http = require('https');

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'storecops.up.railway.app',
      path: '/api/v1' + path,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    if (token) opts.headers.Authorization = 'Bearer ' + token;
    const r = http.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  // Login
  const login = await req('POST', '/auth/login', { email: 'test@storecops.com', password: 'TestPass123' });
  const j = JSON.parse(login.body);
  const token = j.token;
  const store = j.user.store_id;
  console.log('Login:', login.status, '| Store:', store);

  // Test endpoints
  const tests = [
    ['/report/' + store, 'Report'],
    ['/orders/' + store + '/live', 'Orders Live'],
    ['/inventory/' + store + '/levels', 'Inventory'],
    ['/campaigns/' + store, 'Campaigns'],
    ['/rules/' + store, 'Rules'],
    ['/channels/' + store + '/status', 'Channels'],
    ['/segments/' + store, 'Segments'],
    ['/churn/' + store, 'Churn'],
    ['/competitors/' + store, 'Competitors'],
    ['/returns/' + store + '/dashboard', 'Returns Dashboard'],
    ['/notifications/summary', 'Notifications'],
    ['/activity/summary', 'Activity'],
    ['/onboarding/state', 'Onboarding'],
    ['/admin/platform-status', 'Admin Status'],
  ];

  for (const [path, name] of tests) {
    const r = await req('GET', path, null, token);
    const icon = r.status === 200 ? 'OK' : 'FAIL';
    console.log(`[${icon}] ${r.status} ${name} (${path})`);
  }
})();
