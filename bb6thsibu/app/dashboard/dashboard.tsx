// app/dashboard/page.tsx

import { auth } from "@/auth";
const session = await auth();

export default async function DashboardPage() {

  // If the session exists, session.user will have your data
  if (!session?.user) return <div>Not logged in</div>;
  console.log(session)
  return (
    <div>
      <h1>Welcome back, {session.user.name || session.user.email}!</h1>
      <p>Your User ID is: {session.user.id}</p>
    </div>
  );
}