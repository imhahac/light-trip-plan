import React from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { UIProvider, useUIContext } from '../UIContext';
import { STORAGE_KEYS } from '../../constants/storageKeys';

function UIProbe() {
    const {
        activeTab,
        setActiveTab,
        workspaceTabs,
        ticketScope,
        setTicketScope,
        filterStatus,
        setFilterStatus,
    } = useUIContext();

    return (
        <div>
            <div data-testid="activeTab">{activeTab}</div>
            <div data-testid="workspaceTabs">{JSON.stringify(workspaceTabs)}</div>
            <div data-testid="ticketScope">{ticketScope}</div>
            <div data-testid="filterStatus">{filterStatus}</div>
            <button data-testid="btn-tab-planner" onClick={() => setActiveTab('planner')}>Planner</button>
            <button data-testid="btn-tab-hotels" onClick={() => setActiveTab('hotels')}>Hotels</button>
            <button data-testid="btn-scope-all" onClick={() => setTicketScope('all')}>Scope All</button>
            <button data-testid="btn-filter-upcoming" onClick={() => setFilterStatus('upcoming')}>Upcoming</button>
        </div>
    );
}

describe('UIProvider layout & view persistence across page reloads', () => {
    beforeEach(() => {
        window.localStorage.clear();
        cleanup();
    });

    it('remembers activeTab, workspaceTabs, ticketScope, and filterStatus after unmount and remount', () => {
        const firstRender = render(
            <UIProvider>
                <UIProbe />
            </UIProvider>
        );

        expect(firstRender.getByTestId('activeTab').textContent).toBe('timeline');
        expect(firstRender.getByTestId('ticketScope').textContent).toBe('trip');
        expect(firstRender.getByTestId('filterStatus').textContent).toBe('all');

        // User changes layout/tab settings
        fireEvent.click(firstRender.getByTestId('btn-tab-planner'));
        fireEvent.click(firstRender.getByTestId('btn-tab-hotels'));
        fireEvent.click(firstRender.getByTestId('btn-scope-all'));
        fireEvent.click(firstRender.getByTestId('btn-filter-upcoming'));

        expect(firstRender.getByTestId('activeTab').textContent).toBe('hotels');
        expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.UI_ACTIVE_TAB))).toBe('hotels');
        expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.UI_TICKET_SCOPE))).toBe('all');
        expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.UI_FILTER_STATUS))).toBe('upcoming');
        expect(JSON.parse(window.localStorage.getItem(STORAGE_KEYS.UI_WORKSPACE_TABS))).toEqual({
            planning: 'planner',
            tickets: 'hotels',
        });

        // Simulate page refresh by unmounting and remounting fresh provider
        firstRender.unmount();

        const secondRender = render(
            <UIProvider>
                <UIProbe />
            </UIProvider>
        );

        expect(secondRender.getByTestId('activeTab').textContent).toBe('hotels');
        expect(secondRender.getByTestId('ticketScope').textContent).toBe('all');
        expect(secondRender.getByTestId('filterStatus').textContent).toBe('upcoming');
        expect(JSON.parse(secondRender.getByTestId('workspaceTabs').textContent)).toEqual({
            planning: 'planner',
            tickets: 'hotels',
        });
    });
});
