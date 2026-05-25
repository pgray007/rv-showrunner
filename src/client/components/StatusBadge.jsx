const styles = {
  queued:      'bg-blue-900 text-blue-300',
  transcoding: 'bg-yellow-900 text-yellow-300 animate-pulse',
  complete:    'bg-green-900 text-green-300',
  failed:      'bg-red-900 text-red-300',
  cancelled:   'bg-gray-800 text-gray-300',
  deleted:     'bg-gray-800 text-gray-400',
  skipped:     'bg-gray-800 text-gray-500',
};

export default function StatusBadge({ status }) {
  if (!status) return null;
  return (
    <span className={`inline-block text-xs font-medium px-2 py-0.5 rounded-full ${styles[status] || 'bg-gray-800 text-gray-400'}`}>
      {status}
    </span>
  );
}
