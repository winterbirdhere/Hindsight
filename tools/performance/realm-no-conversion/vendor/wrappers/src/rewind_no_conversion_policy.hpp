// SPDX-License-Identifier: Apache-2.0
// Hindsight local fork addition, 2026-11-01. See the fork's PATCH.md.
// Private C++ state only: no existing managed/native structure is changed.
#pragma once

#include <atomic>
#include <cstdint>
#include <stdexcept>

namespace realm::binding {

class RewindNoConversionPolicy {
public:
    static constexpr uint32_t contract_version = 1;
    static constexpr uint32_t required_guarantees = 3; // 1: no format upgrade; 2: no GUID repair/marker

    enum class InstallResult : uint32_t {
        Installed = 0,
        ContractMismatch = 1,
        GuaranteesMismatch = 2,
        AlreadyInstalled = 3,
        OpenAlreadyAttempted = 4,
    };

    InstallResult install(uint32_t version, uint32_t guarantees) noexcept
    {
        if (version != contract_version)
            return InstallResult::ContractMismatch;
        if (guarantees != required_guarantees)
            return InstallResult::GuaranteesMismatch;
        auto expected = State::Fresh;
        if (m_state.compare_exchange_strong(expected, State::Enabled))
            return InstallResult::Installed;
        return expected == State::Enabled ? InstallResult::AlreadyInstalled : InstallResult::OpenAlreadyAttempted;
    }

    bool before_open(bool read_only)
    {
        auto state = m_state.load();
        for (;;) {
            if (state == State::Fresh || state == State::Enabled) {
                auto next = state == State::Enabled ? State::OpenedProtected : State::OpenedUnprotected;
                if (!m_state.compare_exchange_weak(state, next))
                    continue;
                state = next;
            }
            if (state == State::OpenedProtected)
                return true;
            if (!read_only)
                throw std::runtime_error("hindsight-no-conversion:policy-missing");
            return false;
        }
    }

    bool before_reference_open()
    {
        auto state = m_state.load();
        if (state == State::Fresh) {
            m_state.compare_exchange_strong(state, State::OpenedUnprotected);
            throw std::runtime_error("hindsight-no-conversion:reference-before-owner");
        }
        if (state == State::Enabled)
            throw std::runtime_error("hindsight-no-conversion:reference-before-owner");
        return state == State::OpenedProtected;
    }

    bool enabled() const noexcept
    {
        auto state = m_state.load();
        return state == State::Enabled || state == State::OpenedProtected;
    }

private:
    enum class State : uint32_t { Fresh, Enabled, OpenedUnprotected, OpenedProtected };
    std::atomic<State> m_state{State::Fresh};
};

} // namespace realm::binding
