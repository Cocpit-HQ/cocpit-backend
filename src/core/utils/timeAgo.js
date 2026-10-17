const { format, isToday, isYesterday, differenceInMinutes } = require('date-fns');

function timeAgo(date) {
  const d = new Date(date);
  const mins = differenceInMinutes(new Date(), d);

  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m`;
  if (isToday(d)) return format(d, "hh:mm a");
  if (isYesterday(d)) return "Yesterday";
  return format(d, "dd MMM");
}
module.exports = timeAgo;


