/**
 * Show a failed route-save response to the user.
 * A duplicated road_id (409 DUPLICATE_ROAD_ID) shows the server's message asking
 * the user to re-edit the path; anything else shows a generic failure dialog.
 */
export async function alertSaveFailure(res: Response, context: string): Promise<void> {
  const text = await res.text();
  console.error(`[${context}] server error:`, res.status, text);
  let body: any = null;
  try { body = JSON.parse(text); } catch { /* non-JSON body */ }
  if (body?.code === 'DUPLICATE_ROAD_ID') window.alert(body.error);
  else window.alert(`保存に失敗しました (HTTP ${res.status} ${res.statusText})`);
}
