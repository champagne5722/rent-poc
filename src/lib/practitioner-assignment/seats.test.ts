import { describe, expect, it } from 'vitest';
import { routeSignatures, type RoutingFacts } from '../signature-routing';
import { licenseKindForSeat, partyRoleOfEntitySource } from './seats';

function practitionerSeats(routing: RoutingFacts) {
  const route = routeSignatures(routing);
  if (route.kind !== 'sequence') throw new Error('測試的組合必須有簽署序列');
  return route.plan.seats.filter((s) => s.practitioner);
}

const lease = (businessType: 'self_managed' | 'managed' | 'master_lease', lesseeIsMasterLessor = false, brokerMediated = false): RoutingFacts => ({
  documentType: 'lease',
  businessType,
  lesseeIsMasterLessor,
  brokerMediated,
});

describe('licenseKindForSeat：執業人員席位的執業主體要持有哪一種業別', () => {
  it('包租租賃合約：包租業', () => {
    const [seat] = practitionerSeats(lease('master_lease'));
    expect(licenseKindForSeat(lease('master_lease'), seat)).toBe('master_lease');
  });
  it('自管且承租人是包租業者：包租業', () => {
    const routing = lease('self_managed', true);
    const [seat] = practitionerSeats(routing);
    expect(licenseKindForSeat(routing, seat)).toBe('master_lease');
  });
  it('委託管理合約：代管業', () => {
    const routing: RoutingFacts = { documentType: 'management', businessType: 'managed' };
    const [seat] = practitionerSeats(routing);
    expect(licenseKindForSeat(routing, seat)).toBe('management');
  });
  it('居間的經紀人席位：經紀業，不看業務類型', () => {
    const routing = lease('master_lease', false, true);
    const seats = practitionerSeats(routing);
    expect(seats.map((s) => licenseKindForSeat(routing, s))).toEqual(['master_lease', 'brokerage']);
  });
  it('當事人席位沒有業別', () => {
    const route = routeSignatures(lease('master_lease'));
    if (route.kind !== 'sequence') throw new Error('x');
    const party = route.plan.seats.find((s) => s.role === 'party_a')!;
    expect(licenseKindForSeat(lease('master_lease'), party)).toBeNull();
  });
});

describe('partyRoleOfEntitySource', () => {
  it.each([
    ['party_a', 'party_a'],
    ['party_b', 'party_b'],
    ['broker_entity', null],
    ['case_mandatary', null],
  ] as const)('%s → %s', (source, expected) => {
    expect(partyRoleOfEntitySource(source)).toBe(expected);
  });
});
