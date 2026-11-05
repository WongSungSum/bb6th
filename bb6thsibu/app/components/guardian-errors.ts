/**
 * 表单只送出有填写的监护人，所以服务器回传的 guardians.0 不一定是画面上的第 1 格。
 * remap 把错误的位置换回画面上的格子，错误才会显示在对的地方。
 */
export function pickGuardians<G extends Record<string, string>>(list: G[]) {
  const sent = list.map((g, i) => ({ g, i })).filter(({ g }) => Object.values(g).some((x) => x.trim()));
  const remap = (errors: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(errors).map(([k, msg]) => {
        const m = k.match(/^guardians\.(\d+)\.(.+)$/);
        return m && sent[Number(m[1])] ? [`guardians.${sent[Number(m[1])].i}.${m[2]}`, msg] : [k, msg];
      }),
    );
  return { filled: sent.map(({ g }) => g), remap };
}
