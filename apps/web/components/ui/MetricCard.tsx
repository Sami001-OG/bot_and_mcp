export function MetricCard({ icon, label, value, sub, valueClass }: { icon?: React.ReactNode; label: string; value: React.ReactNode; sub?: React.ReactNode; valueClass?: string }) {
  return (
    <article>
      {icon && <div className="icon">{icon}</div>}
      <p>{label}</p>
      <h2 className={valueClass}>{value}</h2>
      {sub && <small>{sub}</small>}
    </article>
  );
}