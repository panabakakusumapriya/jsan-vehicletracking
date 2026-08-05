/**
 * Assigns project PRJ-025-HE-DRIVE-AUSGNZ to the listed driver emails.
 * Run: node scripts/assign-project.mjs
 */

const API = 'https://backend-jsan-vehicletracking-production.up.railway.app';
const PROJECT = 'PRJ-025-HE-DRIVE-AUSGNZ';

const TARGET_EMAILS = [
  'khowkokwei2@gmail.com',
  'scottabdavidson88@gmail.com',
  'bazin961@gmail.com',
  'derrickleatitagaloa07@gmail.com',
  'asimahmad1453@gmail.com',
  'm.aliazhar9899@gmail.com',
  'morganmilesy@gmail.com',
  'vallurishekar69@gmail.com',
  'arvinderbedi@hotmail.com',
  'ali.ahmed194@gmail.com',
  'sofyane_m@outlook.fr',
  'hs83.aus@gmail.com',
  'joelhowells1202@gmail.com',
];

async function run() {
  // 1. Login as admin
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@jsan.local', password: 'Admin@12345' }),
  });
  const loginData = await loginRes.json();
  if (!loginRes.ok) { console.error('Login failed:', loginData); process.exit(1); }
  const token = loginData.token;
  console.log('✓ Logged in as admin\n');

  // 2. Fetch all drivers
  const usersRes = await fetch(`${API}/api/users?role=user`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const usersData = await usersRes.json();
  if (!usersRes.ok) { console.error('Failed to fetch users:', usersData); process.exit(1); }
  const allDrivers = usersData.users ?? [];
  console.log(`Fetched ${allDrivers.length} driver(s) from API\n`);

  // 3. Match and patch
  let matched = 0, notFound = 0;
  for (const email of TARGET_EMAILS) {
    const driver = allDrivers.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (!driver) {
      console.warn(`  NOT FOUND: ${email}`);
      notFound++;
      continue;
    }

    const patchRes = await fetch(`${API}/api/users/${driver._id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ project: PROJECT }),
    });
    const patchData = await patchRes.json();
    if (!patchRes.ok) {
      console.error(`  FAILED  : ${email} — ${patchData?.error ?? patchRes.status}`);
    } else {
      console.log(`  ✓ Updated: ${email}  →  ${PROJECT}`);
      matched++;
    }
  }

  console.log(`\nDone. ${matched} updated, ${notFound} not found.`);
}

run().catch(err => { console.error(err); process.exit(1); });
