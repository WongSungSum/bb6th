import type { Metadata } from 'next';
import Dashboard from "./dashboard";

export const metadata: Metadata = { title: 'Dashboard - BB6th Sibu' };

export default async function DashboardPage(){
  return <Dashboard/>;
}
