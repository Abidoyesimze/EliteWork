import { render, waitFor, fireEvent } from '@testing-library/react-native';
import AdminStreamScreen from './AdminStreamScreen';
import * as adminApiModule from '../api/admin';

jest.mock('../api/admin', () => ({
  adminApi: {
    getAuditTrail: jest.fn(),
  },
}));

const mockRecords: adminApiModule.AdminAuditRecord[] = [
  {
    id: 1,
    action: 'CLAWBACK_INITIATED',
    actorAddress: 'GCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDEFGH',
    targetReference: 'trade-abc-001',
    note: 'Initiated by admin due to fraud report',
    createdAt: '2026-07-01T09:00:00.000Z',
  },
  {
    id: 2,
    action: 'TRADE_RELEASED',
    actorAddress: 'GABCDEFGHIJKLMNOPQRSTUVWXYZ0987654321ABCDEF',
    targetReference: null,
    note: null,
    createdAt: '2026-07-02T14:30:00.000Z',
  },
];

const mockPagination = { page: 1, limit: 50, total: 2, totalPages: 1 };

function mockResolvedAudit(records = mockRecords) {
  (adminApiModule.adminApi.getAuditTrail as jest.Mock).mockResolvedValue({
    items: records,
    pagination: mockPagination,
  });
}

function mockRejectedAudit(message = 'Network error') {
  (adminApiModule.adminApi.getAuditTrail as jest.Mock).mockRejectedValue(new Error(message));
}

describe('AdminStreamScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders the loading state while the request is in flight', () => {
    (adminApiModule.adminApi.getAuditTrail as jest.Mock).mockReturnValue(new Promise(() => {}));

    const { getByTestId, getByText } = render(<AdminStreamScreen />);

    expect(getByTestId('loading-indicator')).toBeTruthy();
    expect(getByText('Loading audit trail…')).toBeTruthy();
  });

  it('renders audit trail items with action and actorAddress after loading', async () => {
    mockResolvedAudit();

    const { getByText } = render(<AdminStreamScreen />);

    await waitFor(() => {
      expect(getByText('CLAWBACK_INITIATED')).toBeTruthy();
      expect(getByText('TRADE_RELEASED')).toBeTruthy();
    });

    expect(getByText('GCDEFG…EFGH')).toBeTruthy();
    expect(getByText('GABCDE…CDEF')).toBeTruthy();
  });

  it('renders targetReference when present', async () => {
    mockResolvedAudit();

    const { getByText } = render(<AdminStreamScreen />);

    await waitFor(() => {
      expect(getByText('ref: trade-abc-001')).toBeTruthy();
    });
  });

  it('renders note when present', async () => {
    mockResolvedAudit();

    const { getByText } = render(<AdminStreamScreen />);

    await waitFor(() => {
      expect(getByText('Initiated by admin due to fraud report')).toBeTruthy();
    });
  });

  it('renders an empty state message when there are no records', async () => {
    mockResolvedAudit([]);

    const { getByText } = render(<AdminStreamScreen />);

    await waitFor(() => {
      expect(getByText('No audit records found')).toBeTruthy();
    });
  });

  it('renders the error state with a retry button when the API call fails', async () => {
    mockRejectedAudit('Failed to fetch audit trail');

    const { getByText } = render(<AdminStreamScreen />);

    await waitFor(() => {
      expect(getByText('Failed to fetch audit trail')).toBeTruthy();
      expect(getByText('Retry')).toBeTruthy();
    });
  });

  it('retries the API call when the Retry button is pressed', async () => {
    (adminApiModule.adminApi.getAuditTrail as jest.Mock)
      .mockRejectedValueOnce(new Error('Temporary error'))
      .mockResolvedValueOnce({ items: mockRecords, pagination: mockPagination });

    const { getByText } = render(<AdminStreamScreen />);

    await waitFor(() => {
      expect(getByText('Retry')).toBeTruthy();
    });

    fireEvent.press(getByText('Retry'));

    await waitFor(() => {
      expect(getByText('CLAWBACK_INITIATED')).toBeTruthy();
    });

    expect(adminApiModule.adminApi.getAuditTrail).toHaveBeenCalledTimes(2);
  });

  it('renders the screen title', async () => {
    mockResolvedAudit();

    const { getByText } = render(<AdminStreamScreen />);

    await waitFor(() => {
      expect(getByText('Admin: Stream Management')).toBeTruthy();
    });
  });

  it('renders the clawback help text', async () => {
    mockResolvedAudit();

    const { getByText } = render(<AdminStreamScreen />);

    await waitFor(() => {
      expect(getByText(/clawback events/i)).toBeTruthy();
    });
  });
});
