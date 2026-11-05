'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { faUserPlus } from '@fortawesome/free-solid-svg-icons';
import { appointCaptainAction } from '@/app/actions/users';
import { logoutAction } from '@/app/actions/auth';
import { Dialog, ErrorBanner, RankBadge, StateCard, SubmitLabel } from '@/app/components/ui';

type Candidate = { id: string; fullName: string; username: string; rankName: string };

export default function Setup({ candidates }: { candidates: Candidate[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState('');
  const [search, setSearch] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const chosen = candidates.find((c) => c.id === selected);
  const shown = candidates.filter((c) => (c.fullName + ' ' + c.username).toLowerCase().includes(search.toLowerCase()));

  const appoint = () =>
    start(async () => {
      const res = await appointCaptainAction(selected);
      if (res.ok) router.replace(`/users/${res.data.id}`);
      else {
        setError(res.message);
        setConfirm(false);
      }
    });

  return (
    <main className="max-w-2xl mx-auto px-4 py-10">
      <div className="flex items-start justify-between gap-3 mb-6">
        <div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight">Set up your company</h1>
          <p className="text-sm text-muted">Appoint the first Captain. The Captain holds all business permissions.</p>
        </div>
        <form action={logoutAction}><button className="text-sm text-muted hover:text-fg">Sign out</button></form>
      </div>
      <ErrorBanner message={error} />

      {candidates.length === 0 ? (
        <StateCard
          icon={faUserPlus}
          title="No active Officers yet"
          text="Add the future Captain as a member of the Officer section first, then come back here."
          action={<Link href="/users/new" className="btn-primary">Add member</Link>}
        />
      ) : (
        <div className="card">
          <input
            className="form-input mb-4"
            placeholder="Search Officers"
            aria-label="Search Officers"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="max-h-72 overflow-y-auto space-y-2" role="radiogroup">
            {shown.map((c) => (
              <label key={c.id} className="flex items-center gap-3 rounded-xl border border-line p-3 cursor-pointer has-[:checked]:border-violet-400 has-[:checked]:bg-violet-500/10">
                <input type="radio" name="candidate" value={c.id} checked={selected === c.id} onChange={() => setSelected(c.id)} className="accent-violet-500" />
                <span className="flex-1 min-w-0">
                  <span className="block font-medium truncate">{c.fullName}</span>
                  <span className="block text-xs text-muted">@{c.username}</span>
                </span>
                <RankBadge name={c.rankName} />
              </label>
            ))}
          </div>
          <p className="text-xs text-muted mt-3">
            Not listed? <Link href="/users/new" className="text-violet-400 hover:text-violet-300">Add the member</Link> to the Officer section first.
          </p>
          <button className="btn-primary w-full mt-4" disabled={!selected} onClick={() => setConfirm(true)}>Appoint as Captain</button>
        </div>
      )}

      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        pending={pending}
        title={`Appoint ${chosen?.fullName ?? ''} as Captain?`}
        body="They will hold all business permissions. Changing the Captain later requires succession."
        footer={
          <>
            <button className="btn-secondary" disabled={pending} onClick={() => setConfirm(false)}>Cancel</button>
            <button className="btn-primary" disabled={pending} onClick={appoint}>
              <SubmitLabel pending={pending} idle="Appoint" busy="Appointing..." />
            </button>
          </>
        }
      />
    </main>
  );
}
