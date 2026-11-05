import Link from 'next/link';
import { faPersonDigging } from '@fortawesome/free-solid-svg-icons';
import { StateCard } from './ui';

/** 还没做好的页面：说明正在开发，给一个回去的按钮，不要让人以为坏掉 */
export default function ComingSoon({ title, text }: { title: string; text: string }) {
  return (
    <div className="max-w-3xl mx-auto">
      <h1 className="text-xl md:text-2xl font-bold tracking-tight mb-4">{title}</h1>
      <StateCard icon={faPersonDigging} title="Coming soon" text={text} action={<Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>} />
    </div>
  );
}
