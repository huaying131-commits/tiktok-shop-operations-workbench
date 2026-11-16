const MINUTE = 60_000;

export const REPLY_WINDOW_MS = 30 * MINUTE;

export function createDemoState(now = Date.now()) {
  const time = minutes => new Date(now + minutes * MINUTE).toISOString();
  const message = (id, from, text, minutes) => ({ id, from, text, at: time(minutes) });

  return {
    mode: 'test',
    shop: '示例马来店',
    conversations: [
      {
        id: 'maya', buyer: 'Maya L.', initials: 'ML', topic: '查询物流', status: 'open',
        dueAt: time(22), assignee: '',
        messages: [
          message('maya-1', 'buyer', 'Hi, boleh semak status penghantaran pesanan saya?', -8),
          message('maya-2', 'auto', 'Hai! Bungkusan anda sedang dalam perjalanan. Nombor penjejakan ujian: DEMO-MY-4821.', -8),
          message('maya-3', 'buyer', 'Terima kasih. Adakah bungkusan sudah sampai di hab tempatan?', -2),
        ],
        order: {
          id: 'DEMO-MY-10482', product: '桌面收纳架 · 奶白色', quantity: 1, total: 'RM 39.90',
          status: '已发货', placedAt: time(-2_880),
          shipment: {
            carrier: '测试物流', tracking: 'DEMO-MY-4821', status: '运输中',
            events: [{ label: '已到达吉隆坡分拣中心', at: time(-87) }, { label: '包裹已揽收', at: time(-1_420) }],
          },
          afterSales: null,
        },
      },
      {
        id: 'amir', buyer: 'Amir R.', initials: 'AR', topic: '退货与退款', status: 'human',
        dueAt: time(8), assignee: '人工客服',
        messages: [
          message('amir-1', 'buyer', 'Hi, saya terima barang hari ini, tapi penutupnya retak. Boleh minta refund?', -22),
          message('amir-2', 'agent', 'Maaf atas masalah ini. Saya akan semak permohonan anda dan kemas kini di sini.', -20),
          message('amir-3', 'buyer', 'Saya sudah hantar permohonan. Perlu pulangkan barang dahulu?', -6),
        ],
        order: {
          id: 'DEMO-MY-10477', product: '便携收纳盒 · 深灰色', quantity: 1, total: 'RM 28.50',
          status: '已送达', placedAt: time(-4_320),
          shipment: {
            carrier: '测试物流', tracking: 'DEMO-MY-4775', status: '已送达',
            events: [{ label: '已送达', at: time(-180) }, { label: '派送中', at: time(-400) }],
          },
          afterSales: {
            id: 'DEMO-RMA-087', type: '退货退款', status: '待人工核查', updatedAt: time(-18),
            notes: '测试买家反馈盒盖开裂，等待客服核对售后记录与处理方式。',
          },
        },
      },
      {
        id: 'siti', buyer: 'Siti N.', initials: 'SN', topic: '商品规格', status: 'open',
        dueAt: time(16), assignee: '',
        messages: [
          message('siti-1', 'buyer', 'Hi, do you have the dimensions for the desk organiser?', -14),
          message('siti-2', 'auto', 'Hi! The demo desk organiser measures 25 × 14 × 11 cm.', -14),
        ],
        order: null,
      },
      {
        id: 'daniel', buyer: 'Daniel T.', initials: 'DT', topic: '配送咨询', status: 'resolved',
        dueAt: time(-41), assignee: '人工客服',
        messages: [
          message('daniel-1', 'buyer', 'The parcel has arrived. Thanks for helping!', -71),
          message('daniel-2', 'agent', 'Glad to hear it. Thank you for letting us know!', -70),
        ],
        order: null,
      },
    ],
  };
}
