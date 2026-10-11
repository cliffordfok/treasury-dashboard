const FIRESTORE_ERROR_MESSAGES = {
  'permission-denied': '資料未通過 Firestore 安全規則（例如日期次序或數值範圍不符），或此帳號未獲授權使用帳本。',
  unauthenticated: '登入狀態已失效，請重新登入後再試。',
  unavailable: '暫時無法連線至 Firestore，請檢查網絡後重試。',
  'deadline-exceeded': '連線逾時，請檢查網絡後重試。',
  'resource-exhausted': 'Firebase 配額已用盡，請稍後再試。',
  'invalid-argument': '資料格式無效，未能寫入。',
};

export const describeFirestoreError = (error) => (
  FIRESTORE_ERROR_MESSAGES[error?.code] ?? '未能完成操作，請稍後重試。'
);
