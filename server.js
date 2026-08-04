async function runCheck() {
  const token = await getGraphToken();
  const values = await readSheet(token);
  const rows = rowsToObjects(values);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const twoMonthsAgo = new Date(today);
  twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

  const overdueRows = rows
    .map((r) => {
      const targetDate = parseExcelDate(r.targetDateRaw);
      return { ...r, targetDate };
    })
    .filter((r) => {
      if (!r.targetDate) return false;
      const isSuccess = r.status.trim().toLowerCase() === "success";
      const isOverdue = r.targetDate.getTime() < today.getTime();
      const withinLookback = r.targetDate.getTime() >= twoMonthsAgo.getTime();
      return !isSuccess && isOverdue && withinLookback;
    })
    .map((r) => ({
      ...r,
      daysOverdue: daysBetween(today, r.targetDate),
      targetDateStr: r.targetDate.toLocaleDateString("th-TH"),
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);

  const messages = buildMessages(overdueRows, today);
  await sendTelegramMessages(messages);
  return { overdueCount: overdueRows.length, messageCount: messages.length };
}
